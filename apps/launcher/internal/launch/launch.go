// Package launch implements the installed launcher (R/MossStudio.exe, R/mossstudio): the
// pending switch, the health check with rollback, cleanup of old app folders, the --restart
// handoff and --uninstall.
//
// # Launch
//
//  1. Read R/install.json (portable folders without one get it created, see Bootstrap; a
//     record whose folder moved gets root, and dataRoot when it was under it, rebased).
//  2. If an app process from R/app-* is already running, only start app-<current> with the
//     arguments (Electron's single-instance lock forwards them) and stop: no switch, no
//     health check, no cleanup while files are in use.
//  3. If pending is set and app-<pending> exists (and is not in failed):
//     previous=current, current=pending, pending unset, confirmed=false. A pending version
//     whose folder is missing or that already failed is dropped. If app-<current> is missing
//     and app-<previous> exists, current falls back to previous.
//  4. Remove app-<v> folders other than current, previous and pending, best-effort (a folder
//     that cannot be renamed aside is in use and is skipped).
//  5. Start app-<current>/MossStudio(.exe) with --moss-launched plus the passthrough
//     arguments and MOSSSTUDIO_ROOT=R, MOSSSTUDIO_LAUNCHER=<launcher path>.
//  6. If confirmed is false, watch: the app writes confirmed=true after HealthConfirm. The
//     launcher rolls back (current joins failed, current=previous, previous unset, start it)
//     only when the child crashes or exits non-zero before confirming. A clean exit (code 0)
//     before the confirm changes nothing: confirmed stays false, nothing is marked failed or
//     started, and the next launch watches again. A child still alive at HealthTimeout keeps
//     being watched until it confirms or exits.
package launch

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/CloverIris/MossStudio/apps/launcher/internal/fsutil"
	"github.com/CloverIris/MossStudio/apps/launcher/internal/payload"
	"github.com/CloverIris/MossStudio/apps/launcher/internal/proc"
	"github.com/CloverIris/MossStudio/apps/launcher/internal/record"
)

// Mirrors of apps/desktop/src/shared/install.ts (a test checks they match).
const (
	HealthConfirm = 8_000 * time.Millisecond
	HealthTimeout = 60_000 * time.Millisecond

	SetupArg     = "--moss-setup"
	SilentArg    = "--moss-silent"
	InstallToArg = "--moss-install-to"
	LaunchedArg  = "--moss-launched"
	UninstallArg = "--moss-uninstall"

	FinishUninstallArg = "--finish-uninstall"

	EnvRoot     = "MOSSSTUDIO_ROOT"
	EnvLauncher = "MOSSSTUDIO_LAUNCHER"

	// PortableFile marks a portable install root.
	PortableFile = "portable.json"
	trashPrefix  = ".moss-trash-"
)

// Clock is the time source; tests use a fake that advances on Sleep.
type Clock interface {
	Now() time.Time
	Sleep(d time.Duration)
}

// RealClock is the wall clock.
type RealClock struct{}

func (RealClock) Now() time.Time        { return time.Now() }
func (RealClock) Sleep(d time.Duration) { time.Sleep(d) }

// Env is everything Launch touches outside install.json and R.
type Env struct {
	Root     string // R
	Launcher string // absolute path of the launcher executable (MOSSSTUDIO_LAUNCHER)
	Platform string // install.json platform key, e.g. "win32-x64"
	GOOS     string // decides the app executable name; defaults to runtime.GOOS
	Runner   proc.Runner
	Clock    Clock
	// Running lists processes whose executable is inside R (not this process).
	Running func(root string) ([]proc.Info, error)
	// BaseEnv is the environment the child inherits (defaults to os.Environ()).
	BaseEnv []string
	Logf    func(format string, args ...any)
}

func (e *Env) logf(format string, args ...any) {
	if e.Logf != nil {
		e.Logf(format, args...)
	}
}

func (e *Env) goos() string {
	if e.GOOS != "" {
		return e.GOOS
	}
	return runtime.GOOS
}

func (e *Env) recordPath() string { return record.Path(e.Root) }

// AppDir returns R/app-<version>.
func (e *Env) AppDir(version string) string { return filepath.Join(e.Root, "app-"+version) }

// AppExe returns the app executable of a version.
func (e *Env) AppExe(version string) string {
	if e.goos() == "windows" {
		return filepath.Join(e.AppDir(version), "MossStudio.exe")
	}
	return filepath.Join(e.AppDir(version), "MossStudio")
}

func (e *Env) hasApp(version string) bool {
	if version == "" {
		return false
	}
	st, err := os.Stat(e.AppExe(version))
	return err == nil && st.Mode().IsRegular()
}

// ChildEnv returns BaseEnv with MOSSSTUDIO_ROOT and MOSSSTUDIO_LAUNCHER replaced.
func (e *Env) ChildEnv() []string {
	base := e.BaseEnv
	if base == nil {
		base = os.Environ()
	}
	fold := e.goos() == "windows"
	out := make([]string, 0, len(base)+2)
	for _, kv := range base {
		k, _, _ := strings.Cut(kv, "=")
		if sameKey(k, EnvRoot, fold) || sameKey(k, EnvLauncher, fold) {
			continue
		}
		out = append(out, kv)
	}
	return append(out, EnvRoot+"="+e.Root, EnvLauncher+"="+e.Launcher)
}

func sameKey(a, b string, fold bool) bool {
	if fold {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// appsRunning reports whether any process runs from an app-* folder of R.
func (e *Env) appsRunning() bool {
	if e.Running == nil {
		return false
	}
	list, err := e.Running(e.Root)
	if err != nil {
		e.logf("cannot list processes: %v", err)
		return false
	}
	for _, p := range list {
		rel, err := filepath.Rel(e.Root, p.Exe)
		if err != nil {
			continue
		}
		first := strings.SplitN(filepath.ToSlash(rel), "/", 2)[0]
		if strings.HasPrefix(strings.ToLower(first), "app-") {
			return true
		}
	}
	return false
}

// Error is a launch failure meant for the user; Detail is technical.
type Error struct {
	Message string // plain Chinese for the dialog
	Detail  string
	Err     error
}

func (e *Error) Error() string {
	if e.Err != nil {
		return e.Message + ": " + e.Err.Error()
	}
	return e.Message
}
func (e *Error) Unwrap() error { return e.Err }

// Load reads install.json, creating it for a portable folder that has none, and rebasing a
// record whose folder moved (root, and dataRoot when it was under the old root).
func (e *Env) Load() (*record.Record, error) {
	path := e.recordPath()
	rec, err := record.Read(path)
	if errors.Is(err, record.ErrMissing) && fsutil.Exists(filepath.Join(e.Root, PortableFile)) {
		return e.Bootstrap()
	}
	var ce *record.CorruptError
	switch {
	case errors.Is(err, record.ErrMissing):
		return nil, &Error{Message: "找不到安装记录，MossStudio 无法启动。请重新运行安装程序修复（你的作品和设置不会丢失）。", Detail: path, Err: err}
	case errors.As(err, &ce):
		return nil, &Error{Message: "安装记录已损坏，MossStudio 无法启动。请重新运行安装程序修复（你的作品和设置不会丢失）。", Detail: ce.Error(), Err: err}
	case err != nil:
		return nil, &Error{Message: "无法读取安装记录，MossStudio 无法启动。", Detail: path, Err: err}
	}
	// The folder moved (portable copied elsewhere, or an install folder moved by hand):
	// root follows the launcher, and so does dataRoot when it lived under the old root.
	if !fsutil.SamePath(rec.Root, e.Root, fsutil.FoldCase) {
		old := rec.Root
		if filepath.IsAbs(old) && fsutil.Inside(old, rec.DataRoot, fsutil.FoldCase) {
			if rel, err := filepath.Rel(filepath.Clean(old), filepath.Clean(rec.DataRoot)); err == nil {
				rec.DataRoot = filepath.Join(e.Root, rel)
			}
		}
		rec.Root = e.Root
		rec.Touch(e.Clock.Now())
		if err := record.Write(path, rec); err != nil {
			return nil, &Error{Message: "无法更新安装记录。请确认 MossStudio 所在的文件夹可以写入。", Detail: path, Err: err}
		}
		e.logf("install folder moved from %s to %s (dataRoot %s)", old, e.Root, rec.DataRoot)
	}
	return rec, nil
}

// Bootstrap writes install.json for a portable folder (R/portable.json present):
// current = portable.json's "version" when app-<version> exists, else the only app-<v>
// folder; portable=true, dataRoot=R/data, channel stable (or portable.json's "channel" when
// it is stable or beta), confirmed=false.
func (e *Env) Bootstrap() (*record.Record, error) {
	var marker struct {
		Version string `json:"version"`
		Channel string `json:"channel"`
	}
	if data, err := os.ReadFile(filepath.Join(e.Root, PortableFile)); err == nil {
		json.Unmarshal(data, &marker)
	}
	current := ""
	if record.IsSemver(marker.Version) && e.hasApp(marker.Version) {
		current = marker.Version
	} else if versions := e.appVersions(); len(versions) == 1 {
		current = versions[0]
	} else {
		return nil, &Error{Message: "便携版文件夹不完整，MossStudio 无法启动。请重新解压便携版压缩包。",
			Detail: fmt.Sprintf("%s: portable.json names no usable version and there is not exactly one app-<version> folder (%v)", e.Root, versions)}
	}
	channel := "stable"
	if marker.Channel == "beta" {
		channel = "beta"
	}
	now := e.Clock.Now()
	rec := &record.Record{
		Schema: 1, Platform: e.Platform, Root: e.Root, DataRoot: filepath.Join(e.Root, "data"),
		Portable: true, Channel: channel, Current: current, Failed: []string{}, Confirmed: false,
	}
	rec.Touch(now)
	rec.InstalledAt = rec.UpdatedAt
	if err := record.Write(e.recordPath(), rec); err != nil {
		return nil, &Error{Message: "无法写入安装记录。请把便携版放到可以写入的文件夹。", Detail: e.recordPath(), Err: err}
	}
	e.logf("created %s for portable %s", record.FileName, current)
	return rec, nil
}

// appVersions lists the versions of R/app-<semver> folders, sorted.
func (e *Env) appVersions() []string {
	ents, _ := os.ReadDir(e.Root)
	var out []string
	for _, d := range ents {
		if v := payload.AppDirVersion(d.Name()); v != "" && d.IsDir() {
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}

// Prepare applies the pending switch and missing-folder fallback to rec, writing it when it
// changes. It reports an *Error if no version can be started.
func (e *Env) Prepare(rec *record.Record) error {
	changed := false
	if rec.Pending != "" {
		switch {
		case rec.Pending == rec.Current:
			e.logf("pending %s is already current", rec.Pending)
		case rec.IsFailed(rec.Pending):
			e.logf("pending %s failed before; dropping it", rec.Pending)
		case !e.hasApp(rec.Pending):
			e.logf("pending %s has no app folder; dropping it", rec.Pending)
		default:
			e.logf("switching %s -> %s", rec.Current, rec.Pending)
			rec.Previous, rec.Current, rec.Confirmed = rec.Current, rec.Pending, false
		}
		rec.Pending = ""
		changed = true
	}
	if !e.hasApp(rec.Current) {
		if rec.Previous != "" && e.hasApp(rec.Previous) {
			e.logf("current %s is missing; falling back to %s", rec.Current, rec.Previous)
			rec.Current, rec.Previous, rec.Confirmed = rec.Previous, "", false
			changed = true
		} else {
			return &Error{Message: "MossStudio 的程序文件缺失，无法启动。请重新运行安装程序修复（你的作品和设置不会丢失）。", Detail: e.AppExe(rec.Current)}
		}
	}
	if changed {
		rec.Touch(e.Clock.Now())
		if err := record.Write(e.recordPath(), rec); err != nil {
			return &Error{Message: "无法更新安装记录。请确认 MossStudio 所在的文件夹可以写入。", Detail: e.recordPath(), Err: err}
		}
	}
	return nil
}

// Cleanup removes app-<v> folders that are not current, previous or pending, plus leftovers
// of earlier cleanups. A folder is first renamed aside (which fails while any file in it is
// in use on Windows, so it is skipped intact) and then deleted. Errors are logged only.
func (e *Env) Cleanup(rec *record.Record) {
	keep := map[string]bool{rec.Current: true, rec.Previous: true, rec.Pending: true}
	ents, err := os.ReadDir(e.Root)
	if err != nil {
		e.logf("cleanup: %v", err)
		return
	}
	for _, d := range ents {
		name := d.Name()
		full := filepath.Join(e.Root, name)
		if strings.HasPrefix(name, trashPrefix) {
			if err := os.RemoveAll(full); err != nil {
				e.logf("cleanup: %v", err)
			}
			continue
		}
		v := payload.AppDirVersion(name)
		if v == "" || keep[v] || !d.IsDir() {
			continue
		}
		trash := filepath.Join(e.Root, trashPrefix+name+"-"+fsutil.RandomSuffix())
		if err := os.Rename(full, trash); err != nil {
			e.logf("cleanup: %s is in use, kept: %v", name, err)
			continue
		}
		if err := os.RemoveAll(trash); err != nil {
			e.logf("cleanup: %v", err)
		}
		e.logf("cleanup: removed %s", name)
	}
}

// Outcome of a health watch.
type Outcome int

const (
	Healthy     Outcome = iota // confirmed=true seen
	Superseded                 // install.json now points at another version
	ExitedClean                // exited with code 0 without confirming: the user quit; watch again next launch
	RollBack                   // crashed or exited non-zero before confirming: roll back
)

// Watch polls install.json and the child until one of the outcomes holds. Only a crash or a
// non-zero exit before the confirm rolls back; a clean exit (the user closed the window, or
// quit to uninstall) leaves confirmed=false so the next launch watches again. A child that
// is alive at HealthTimeout keeps being watched (more slowly) until it confirms or exits.
func (e *Env) Watch(version string, p proc.Process) (Outcome, int, string) {
	deadline := e.Clock.Now().Add(HealthTimeout)
	check := func() (Outcome, bool) {
		r, err := record.Read(e.recordPath())
		if err != nil {
			return 0, false
		}
		if r.Current != version {
			return Superseded, true
		}
		if r.Confirmed {
			return Healthy, true
		}
		return 0, false
	}
	for {
		if o, ok := check(); ok {
			return o, 0, ""
		}
		if code, done := p.Exited(); done {
			if o, ok := check(); ok { // a confirm may have raced the exit
				return o, code, ""
			}
			if code != 0 {
				return RollBack, code, fmt.Sprintf("exited with code %d before confirming", code)
			}
			return ExitedClean, code, ""
		}
		if e.Clock.Now().Before(deadline) {
			e.Clock.Sleep(250 * time.Millisecond)
		} else {
			e.Clock.Sleep(2 * time.Second)
		}
	}
}

// start runs app-<version> with --moss-launched and args.
func (e *Env) start(version string, args []string) (proc.Process, error) {
	p, err := e.Runner.Start(e.AppExe(version), append([]string{LaunchedArg}, args...), e.ChildEnv())
	if err != nil {
		return nil, &Error{Message: "无法启动 MossStudio。", Detail: e.AppExe(version), Err: err}
	}
	return p, nil
}

// Launch runs the launch sequence (see the package doc) and returns the launcher's exit
// code: 0, or the child's code when it ended during the watch.
func (e *Env) Launch(args []string) (int, error) {
	rec, err := e.Load()
	if err != nil {
		return 1, err
	}
	if e.appsRunning() {
		e.logf("MossStudio is already running; forwarding to it")
		if !e.hasApp(rec.Current) {
			return 1, &Error{Message: "MossStudio 的程序文件缺失，无法启动。", Detail: e.AppExe(rec.Current)}
		}
		_, err := e.start(rec.Current, args)
		return 0, err
	}
	if err := e.Prepare(rec); err != nil {
		return 1, err
	}
	e.Cleanup(rec)
	p, err := e.start(rec.Current, args)
	if err != nil {
		return 1, err
	}
	if rec.Confirmed {
		return 0, nil
	}
	outcome, code, reason := e.Watch(rec.Current, p)
	switch outcome {
	case Healthy, Superseded:
		return 0, nil
	case ExitedClean:
		e.logf("%s exited cleanly before confirming; it will be watched again on the next launch", rec.Current)
		return code, nil
	}
	return e.rollback(rec.Current, reason, code, args)
}

// rollback marks version failed and starts previous, if there is one.
func (e *Env) rollback(version, reason string, code int, args []string) (int, error) {
	rec, err := record.Read(e.recordPath())
	if err != nil {
		return code, &Error{Message: "MossStudio 启动失败，且无法读取安装记录。", Detail: reason, Err: err}
	}
	if rec.Current != version || rec.Confirmed {
		return code, nil
	}
	if rec.Previous == "" || !e.hasApp(rec.Previous) {
		e.logf("%s %s; no previous version to fall back to", version, reason)
		return code, nil
	}
	e.logf("%s %s; rolling back to %s", version, reason, rec.Previous)
	rec.MarkFailed(version)
	rec.Current, rec.Previous, rec.Pending, rec.Confirmed = rec.Previous, "", "", false
	rec.Touch(e.Clock.Now())
	if err := record.Write(e.recordPath(), rec); err != nil {
		return code, &Error{Message: "新版本启动失败，且无法切换回上一个版本。请重新运行安装程序修复。", Detail: reason, Err: err}
	}
	if _, err := e.start(rec.Current, args); err != nil {
		return 1, err
	}
	return 0, nil
}

// RestartPidWait caps the wait for the quitting app's pid in Restart.
const RestartPidWait = 60 * time.Second

// Restart waits for the quitting app (pid; 0 = unknown, up to RestartPidWait) and for every
// app process under R to exit (up to 30 s more), then runs Launch. waitPid reports whether pid exited within the timeout.
func (e *Env) Restart(pid int, waitPid func(pid int, timeout time.Duration) bool, args []string) (int, error) {
	if pid > 0 && waitPid != nil && !waitPid(pid, RestartPidWait) {
		e.logf("restart: pid %d still running after %v; continuing", pid, RestartPidWait)
	}
	deadline := e.Clock.Now().Add(30 * time.Second)
	for e.appsRunning() && e.Clock.Now().Before(deadline) {
		e.Clock.Sleep(200 * time.Millisecond)
	}
	return e.Launch(args)
}

// Uninstall starts the current app with --moss-uninstall (no health check, no switch). When
// install.json is missing or damaged it starts the newest app-<v> folder instead, so the
// uninstaller opens from Apps & Features even when the record is gone.
func (e *Env) Uninstall(args []string) error {
	v := ""
	rec, err := e.Load()
	var ce *record.CorruptError
	switch {
	case err == nil:
		v = rec.Current
		if !e.hasApp(v) && e.hasApp(rec.Previous) {
			v = rec.Previous
		}
	case errors.Is(err, record.ErrMissing) || errors.As(err, &ce):
		v = NewestVersion(e.appVersions())
		e.logf("uninstall: %v; using the newest app folder %q", err, v)
	default:
		return err
	}
	if !e.hasApp(v) {
		return &Error{Message: "MossStudio 的程序文件缺失，无法打开卸载程序。请重新运行安装程序修复后再卸载。", Detail: e.AppExe(v)}
	}
	_, err = e.Runner.Start(e.AppExe(v), append([]string{UninstallArg}, args...), e.ChildEnv())
	if err != nil {
		return &Error{Message: "无法打开 MossStudio 卸载程序。", Detail: e.AppExe(v), Err: err}
	}
	return nil
}

// NewestVersion returns the highest version by semver precedence, or "".
func NewestVersion(versions []string) string {
	best := ""
	for _, v := range versions {
		if best == "" || CompareSemver(v, best) > 0 {
			best = v
		}
	}
	return best
}

// CompareSemver orders two semver strings (-1, 0, 1) by semver 2.0 precedence; build
// metadata is not part of the contract's versions.
func CompareSemver(a, b string) int {
	coreA, preA, _ := strings.Cut(a, "-")
	coreB, preB, _ := strings.Cut(b, "-")
	pa, pb := strings.Split(coreA, "."), strings.Split(coreB, ".")
	for i := 0; i < 3 && i < len(pa) && i < len(pb); i++ {
		if c := compareNumeric(pa[i], pb[i]); c != 0 {
			return c
		}
	}
	switch {
	case preA == preB:
		return 0
	case preA == "":
		return 1
	case preB == "":
		return -1
	}
	ia, ib := strings.Split(preA, "."), strings.Split(preB, ".")
	for i := 0; i < len(ia) && i < len(ib); i++ {
		na, errA := strconv.Atoi(ia[i])
		nb, errB := strconv.Atoi(ib[i])
		switch {
		case errA == nil && errB == nil && na != nb:
			if na < nb {
				return -1
			}
			return 1
		case errA == nil && errB != nil:
			return -1
		case errA != nil && errB == nil:
			return 1
		case errA != nil && errB != nil && ia[i] != ib[i]:
			return strings.Compare(ia[i], ib[i])
		}
	}
	return compareInts(len(ia), len(ib))
}

func compareNumeric(a, b string) int {
	na, _ := strconv.Atoi(a)
	nb, _ := strconv.Atoi(b)
	return compareInts(na, nb)
}

func compareInts(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}
