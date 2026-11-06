package launch

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/CloverIris/MossStudio/apps/launcher/internal/proc"
	"github.com/CloverIris/MossStudio/apps/launcher/internal/record"
)

// fakeClock advances only when slept on and runs scheduled events as time passes.
type fakeClock struct {
	now    time.Time
	events []event
}

type event struct {
	at time.Time
	fn func()
}

func (c *fakeClock) Now() time.Time { return c.now }
func (c *fakeClock) Sleep(d time.Duration) {
	c.now = c.now.Add(d)
	sort.SliceStable(c.events, func(i, j int) bool { return c.events[i].at.Before(c.events[j].at) })
	for len(c.events) > 0 && !c.events[0].at.After(c.now) {
		ev := c.events[0]
		c.events = c.events[1:]
		ev.fn()
	}
}
func (c *fakeClock) after(d time.Duration, fn func()) {
	c.events = append(c.events, event{c.now.Add(d), fn})
}

type fakeProc struct {
	pid    int
	code   int
	exited bool
}

func (p *fakeProc) Pid() int            { return p.pid }
func (p *fakeProc) Exited() (int, bool) { return p.code, p.exited }

type start struct {
	exe  string
	args []string
	env  []string
}

// behaviour describes what a started app version does, in fake time.
type behaviour struct {
	confirmAfter time.Duration // write confirmed=true after this long (0 = never)
	exitAfter    time.Duration // exit after this long (0 = never)
	exitCode     int
}

type fakeRunner struct {
	t       *testing.T
	env     *Env
	clock   *fakeClock
	starts  []start
	byVer   map[string]behaviour
	failErr error
}

func (r *fakeRunner) Start(exe string, args, env []string) (proc.Process, error) {
	if r.failErr != nil {
		return nil, r.failErr
	}
	r.starts = append(r.starts, start{exe, args, env})
	ver := strings.TrimPrefix(filepath.Base(filepath.Dir(exe)), "app-")
	p := &fakeProc{pid: 1000 + len(r.starts)}
	b := r.byVer[ver]
	if b.confirmAfter > 0 {
		r.clock.after(b.confirmAfter, func() {
			if p.exited {
				return
			}
			rec, err := record.Read(record.Path(r.env.Root))
			if err != nil {
				r.t.Errorf("app could not read record: %v", err)
				return
			}
			rec.Confirmed = true
			if err := record.Write(record.Path(r.env.Root), rec); err != nil {
				r.t.Error(err)
			}
		})
	}
	if b.exitAfter > 0 {
		r.clock.after(b.exitAfter, func() { p.code, p.exited = b.exitCode, true })
	}
	return p, nil
}

type fixture struct {
	t      *testing.T
	env    *Env
	clock  *fakeClock
	runner *fakeRunner
	logs   []string
	procs  []proc.Info
}

func newFixture(t *testing.T, versions ...string) *fixture {
	t.Helper()
	root := filepath.Join(t.TempDir(), "Moss Studio 安装")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	f := &fixture{t: t, clock: &fakeClock{now: time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)}}
	f.env = &Env{
		Root: root, Launcher: filepath.Join(root, "mossstudio"), Platform: "linux-x64", GOOS: "linux",
		Clock: f.clock, BaseEnv: []string{"PATH=/usr/bin", "MOSSSTUDIO_ROOT=/stale", "HOME=/home/u"},
		Running: func(string) ([]proc.Info, error) { return f.procs, nil },
	}
	f.env.Logf = func(format string, args ...any) { f.logs = append(f.logs, format) }
	f.runner = &fakeRunner{t: t, env: f.env, clock: f.clock, byVer: map[string]behaviour{}}
	f.env.Runner = f.runner
	for _, v := range versions {
		f.addApp(v)
	}
	return f
}

func (f *fixture) addApp(v string) {
	dir := filepath.Join(f.env.Root, "app-"+v)
	if err := os.MkdirAll(filepath.Join(dir, "resources"), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "MossStudio"), []byte("app"), 0o755); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) write(mut func(r *record.Record)) {
	r := &record.Record{Schema: 1, Platform: "linux-x64", Root: f.env.Root, DataRoot: filepath.Join(f.env.Root, "data"),
		Channel: "stable", Current: "1.0.0", Failed: []string{}, Confirmed: true,
		InstalledAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-01T00:00:00.000Z"}
	r.SetExtra("keepMe", []byte(`{"a":1}`))
	if mut != nil {
		mut(r)
	}
	if err := record.Write(record.Path(f.env.Root), r); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) read() *record.Record {
	r, err := record.Read(record.Path(f.env.Root))
	if err != nil {
		f.t.Fatal(err)
	}
	return r
}

func (f *fixture) startedVersions() []string {
	var out []string
	for _, s := range f.runner.starts {
		out = append(out, strings.TrimPrefix(filepath.Base(filepath.Dir(s.exe)), "app-"))
	}
	return out
}

func TestLaunchConfirmedStartsCurrentWithArgsAndEnv(t *testing.T) {
	f := newFixture(t, "1.0.0")
	f.write(nil)
	code, err := f.env.Launch([]string{"--open", "/home/u/作品 1.png"})
	if err != nil || code != 0 {
		t.Fatal(code, err)
	}
	if len(f.runner.starts) != 1 {
		t.Fatalf("starts = %v", f.runner.starts)
	}
	s := f.runner.starts[0]
	if s.exe != filepath.Join(f.env.Root, "app-1.0.0", "MossStudio") {
		t.Errorf("exe = %s", s.exe)
	}
	if strings.Join(s.args, "|") != "--moss-launched|--open|/home/u/作品 1.png" {
		t.Errorf("args = %q", s.args)
	}
	env := strings.Join(s.env, "\n")
	if !strings.Contains(env, "MOSSSTUDIO_ROOT="+f.env.Root) || strings.Contains(env, "/stale") ||
		!strings.Contains(env, "MOSSSTUDIO_LAUNCHER="+f.env.Launcher) || !strings.Contains(env, "HOME=/home/u") {
		t.Errorf("env = %v", s.env)
	}
	if f.clock.now != (time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)) {
		t.Error("a confirmed version must not be watched")
	}
}

func TestWindowsExeAndEnvCaseFolding(t *testing.T) {
	f := newFixture(t)
	f.env.GOOS = "windows"
	f.env.BaseEnv = []string{"MossStudio_Root=x", "Path=C:\\Windows"}
	if got := f.env.AppExe("1.2.3"); got != filepath.Join(f.env.Root, "app-1.2.3", "MossStudio.exe") {
		t.Fatal(got)
	}
	env := f.env.ChildEnv()
	if len(env) != 3 || env[0] != "Path=C:\\Windows" {
		t.Fatalf("env = %v", env)
	}
}

func TestPendingSwitch(t *testing.T) {
	f := newFixture(t, "1.0.0", "1.1.0")
	f.write(func(r *record.Record) { r.Pending = "1.1.0" })
	f.runner.byVer["1.1.0"] = behaviour{confirmAfter: HealthConfirm}
	code, err := f.env.Launch(nil)
	if err != nil || code != 0 {
		t.Fatal(code, err)
	}
	r := f.read()
	if r.Current != "1.1.0" || r.Previous != "1.0.0" || r.Pending != "" || !r.Confirmed {
		t.Fatalf("record %+v", r)
	}
	if got := f.startedVersions(); len(got) != 1 || got[0] != "1.1.0" {
		t.Fatalf("started %v", got)
	}
	if _, ok := r.Extra()["keepMe"]; !ok {
		t.Error("unknown key lost by the switch")
	}
}

func TestPendingDroppedWhenMissingOrFailed(t *testing.T) {
	for name, mut := range map[string]func(*record.Record){
		"missing folder":  func(r *record.Record) { r.Pending = "2.0.0" },
		"failed before":   func(r *record.Record) { r.Pending = "1.1.0"; r.Failed = []string{"1.1.0"} },
		"same as current": func(r *record.Record) { r.Pending = "1.0.0" },
	} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, "1.0.0", "1.1.0")
			f.write(mut)
			if _, err := f.env.Launch(nil); err != nil {
				t.Fatal(err)
			}
			r := f.read()
			if r.Current != "1.0.0" || r.Pending != "" || !r.Confirmed {
				t.Fatalf("record %+v", r)
			}
		})
	}
}

func TestRollbackOnCrash(t *testing.T) {
	f := newFixture(t, "1.0.0", "1.1.0")
	f.write(func(r *record.Record) { r.Pending = "1.1.0" })
	f.runner.byVer["1.1.0"] = behaviour{exitAfter: 3 * time.Second, exitCode: 3221225477 & 0x7fffffff}
	code, err := f.env.Launch([]string{"--x"})
	if err != nil || code != 0 {
		t.Fatal(code, err)
	}
	r := f.read()
	if r.Current != "1.0.0" || r.Previous != "" || !r.IsFailed("1.1.0") || r.Confirmed {
		t.Fatalf("record %+v", r)
	}
	if got := f.startedVersions(); strings.Join(got, ",") != "1.1.0,1.0.0" {
		t.Fatalf("started %v", got)
	}
	if args := f.runner.starts[1].args; strings.Join(args, " ") != "--moss-launched --x" {
		t.Errorf("fallback args %v", args)
	}
	// The failed version is never switched to again and its folder goes on the next launch.
	f.write(func(r *record.Record) { r.Failed = []string{"1.1.0"}; r.Pending = "1.1.0" })
	if _, err := f.env.Launch(nil); err != nil {
		t.Fatal(err)
	}
	if r := f.read(); r.Current != "1.0.0" || r.Pending != "" {
		t.Fatalf("record %+v", r)
	}
	if _, err := os.Stat(f.env.AppDir("1.1.0")); !errors.Is(err, os.ErrNotExist) {
		t.Error("failed version's folder should be cleaned up")
	}
}

func TestRollbackOnSignalDeath(t *testing.T) {
	// proc.ExecRunner reports a process killed by a signal as code -1.
	f := newFixture(t, "1.0.0", "1.1.0")
	f.write(func(r *record.Record) { r.Pending = "1.1.0" })
	f.runner.byVer["1.1.0"] = behaviour{exitAfter: 2 * time.Second, exitCode: -1}
	if _, err := f.env.Launch(nil); err != nil {
		t.Fatal(err)
	}
	if r := f.read(); r.Current != "1.0.0" || !r.IsFailed("1.1.0") {
		t.Fatalf("record %+v", r)
	}
}

func TestRollbackOnNonZeroExitAfterTimeout(t *testing.T) {
	f := newFixture(t, "1.0.0", "1.1.0")
	f.write(func(r *record.Record) { r.Current = "1.1.0"; r.Previous = "1.0.0"; r.Confirmed = false })
	f.runner.byVer["1.1.0"] = behaviour{exitAfter: 5 * time.Minute, exitCode: 1}
	if _, err := f.env.Launch(nil); err != nil {
		t.Fatal(err)
	}
	if r := f.read(); r.Current != "1.0.0" || !r.IsFailed("1.1.0") {
		t.Fatalf("record %+v", r)
	}
}

func TestCleanExitBeforeConfirmDoesNotRollBack(t *testing.T) {
	// The user closes the window after ~5 s (or quits to uninstall): not a failure.
	f := newFixture(t, "1.0.0", "1.1.0")
	f.write(func(r *record.Record) { r.Pending = "1.1.0" })
	f.runner.byVer["1.1.0"] = behaviour{exitAfter: 5 * time.Second, exitCode: 0}
	code, err := f.env.Launch(nil)
	if err != nil || code != 0 {
		t.Fatal(code, err)
	}
	r := f.read()
	if r.Current != "1.1.0" || r.Previous != "1.0.0" || r.Confirmed || r.IsFailed("1.1.0") {
		t.Fatalf("record %+v", r)
	}
	if got := f.startedVersions(); len(got) != 1 || got[0] != "1.1.0" {
		t.Fatalf("nothing else may start: %v", got)
	}
	if f.clock.now.Sub(time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)) > 6*time.Second {
		t.Error("the launcher should stop watching as soon as the child exits")
	}
	// The next launch watches again: a crash then rolls back.
	f.runner.byVer["1.1.0"] = behaviour{exitAfter: time.Second, exitCode: 9}
	if _, err := f.env.Launch(nil); err != nil {
		t.Fatal(err)
	}
	if r := f.read(); r.Current != "1.0.0" || !r.IsFailed("1.1.0") {
		t.Fatalf("second launch: %+v", r)
	}
}

func TestNoRollbackWhenAliveAtTimeoutThenCleanExit(t *testing.T) {
	f := newFixture(t, "1.0.0", "1.1.0")
	f.write(func(r *record.Record) { r.Pending = "1.1.0" })
	f.runner.byVer["1.1.0"] = behaviour{exitAfter: HealthTimeout + 10*time.Second, exitCode: 0}
	code, err := f.env.Launch(nil)
	if err != nil || code != 0 {
		t.Fatal(code, err)
	}
	if r := f.read(); r.Current != "1.1.0" || r.IsFailed("1.1.0") || len(f.runner.starts) != 1 {
		t.Fatalf("record %+v starts %v", r, f.startedVersions())
	}
}

func TestTimeoutHungChildThenCrash(t *testing.T) {
	// Alive past the timeout without confirming, then exits non-zero: rolled back.
	f := newFixture(t, "1.0.0", "1.1.0")
	f.write(func(r *record.Record) { r.Pending = "1.1.0" })
	f.runner.byVer["1.1.0"] = behaviour{exitAfter: HealthTimeout + 30*time.Second, exitCode: 2}
	if _, err := f.env.Launch(nil); err != nil {
		t.Fatal(err)
	}
	if f.clock.now.Sub(time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)) < HealthTimeout {
		t.Fatal("watch ended before the timeout")
	}
	if r := f.read(); r.Current != "1.0.0" || !r.IsFailed("1.1.0") {
		t.Fatalf("record %+v", r)
	}
}

func TestConfirmRacingExitIsHealthy(t *testing.T) {
	f := newFixture(t, "1.0.0", "1.1.0")
	f.write(func(r *record.Record) { r.Pending = "1.1.0" })
	f.runner.byVer["1.1.0"] = behaviour{confirmAfter: 9 * time.Second, exitAfter: 9*time.Second + time.Millisecond, exitCode: 0}
	if _, err := f.env.Launch(nil); err != nil {
		t.Fatal(err)
	}
	if r := f.read(); r.Current != "1.1.0" || !r.Confirmed || len(r.Failed) != 0 {
		t.Fatalf("record %+v", r)
	}
}

func TestCrashWithoutPreviousKeepsCurrent(t *testing.T) {
	f := newFixture(t, "1.0.0")
	f.write(func(r *record.Record) { r.Confirmed = false })
	f.runner.byVer["1.0.0"] = behaviour{exitAfter: time.Second, exitCode: 7}
	code, err := f.env.Launch(nil)
	if err != nil || code != 7 {
		t.Fatalf("code %d err %v", code, err)
	}
	if r := f.read(); r.Current != "1.0.0" || len(r.Failed) != 0 || len(f.runner.starts) != 1 {
		t.Fatalf("record %+v", r)
	}
}

func TestSupersededStopsWatching(t *testing.T) {
	f := newFixture(t, "1.0.0", "1.1.0")
	f.write(func(r *record.Record) { r.Pending = "1.1.0" })
	// The app rolls back from Settings after 4s and exits.
	f.runner.byVer["1.1.0"] = behaviour{exitAfter: 5 * time.Second, exitCode: 0}
	f.clock.after(4*time.Second, func() {
		r := f.read()
		r.Current, r.Previous = "1.0.0", "1.1.0"
		record.Write(record.Path(f.env.Root), r)
	})
	if _, err := f.env.Launch(nil); err != nil {
		t.Fatal(err)
	}
	if r := f.read(); r.Current != "1.0.0" || r.IsFailed("1.1.0") || len(f.runner.starts) != 1 {
		t.Fatalf("record %+v", r)
	}
}

func TestAlreadyRunningOnlyForwards(t *testing.T) {
	f := newFixture(t, "1.0.0", "1.1.0", "0.9.0")
	f.write(func(r *record.Record) { r.Pending = "1.1.0" })
	f.procs = []proc.Info{{Pid: 5, Exe: filepath.Join(f.env.Root, "app-1.0.0", "MossStudio")}}
	if _, err := f.env.Launch([]string{"file.png"}); err != nil {
		t.Fatal(err)
	}
	r := f.read()
	if r.Current != "1.0.0" || r.Pending != "1.1.0" {
		t.Fatalf("switch must wait while the app runs: %+v", r)
	}
	if _, err := os.Stat(f.env.AppDir("0.9.0")); err != nil {
		t.Error("no cleanup while the app runs")
	}
	if got := f.startedVersions(); len(got) != 1 || got[0] != "1.0.0" {
		t.Fatalf("started %v", got)
	}
	// A running launcher (not an app folder) does not count as the app.
	f.procs = []proc.Info{{Pid: 6, Exe: f.env.Launcher}}
	if f.env.appsRunning() {
		t.Error("launcher process counted as app")
	}
}

func TestCleanupKeepsCurrentPreviousPending(t *testing.T) {
	f := newFixture(t, "0.8.0", "0.9.0", "1.0.0", "1.1.0", "1.2.0")
	os.MkdirAll(filepath.Join(f.env.Root, "app-1.3.0.partial"), 0o755)
	os.MkdirAll(filepath.Join(f.env.Root, ".moss-trash-app-0.1.0-deadbeef", "x"), 0o755)
	os.MkdirAll(filepath.Join(f.env.Root, "data", "app-0.1.0"), 0o755)
	os.WriteFile(filepath.Join(f.env.Root, "app-0.7.0"), []byte("not a dir"), 0o644)
	f.write(func(r *record.Record) { r.Current = "1.1.0"; r.Previous = "1.0.0"; r.Pending = "1.2.0" })
	f.env.Cleanup(f.read())
	var names []string
	ents, _ := os.ReadDir(f.env.Root)
	for _, e := range ents {
		names = append(names, e.Name())
	}
	want := "app-0.7.0,app-1.0.0,app-1.1.0,app-1.2.0,app-1.3.0.partial,data,install.json"
	if strings.Join(names, ",") != want {
		t.Fatalf("after cleanup: %v\nwant %s", names, want)
	}
}

func TestCurrentMissingFallsBackToPrevious(t *testing.T) {
	f := newFixture(t, "1.0.0")
	f.runner.byVer["1.0.0"] = behaviour{confirmAfter: HealthConfirm}
	f.write(func(r *record.Record) { r.Current = "1.1.0"; r.Previous = "1.0.0" })
	if _, err := f.env.Launch(nil); err != nil {
		t.Fatal(err)
	}
	if r := f.read(); r.Current != "1.0.0" || r.Previous != "" {
		t.Fatalf("record %+v", r)
	}
}

func TestMissingAndCorruptRecordAreClearErrors(t *testing.T) {
	f := newFixture(t, "1.0.0")
	_, err := f.env.Launch(nil)
	var le *Error
	if !errors.As(err, &le) || !strings.Contains(le.Message, "找不到安装记录") || !errors.Is(err, record.ErrMissing) {
		t.Fatalf("missing: %v", err)
	}
	os.WriteFile(record.Path(f.env.Root), []byte("{garbage"), 0o644)
	_, err = f.env.Launch(nil)
	if !errors.As(err, &le) || !strings.Contains(le.Message, "已损坏") {
		t.Fatalf("corrupt: %v", err)
	}
	f.write(func(r *record.Record) { r.Current = "3.0.0" })
	_, err = f.env.Launch(nil)
	if !errors.As(err, &le) || !strings.Contains(le.Message, "程序文件缺失") {
		t.Fatalf("no app: %v", err)
	}
	if len(f.runner.starts) != 0 {
		t.Fatal("nothing should start")
	}
}

func TestStartFailureIsAnError(t *testing.T) {
	f := newFixture(t, "1.0.0")
	f.write(nil)
	f.runner.failErr = errors.New("exec format error")
	_, err := f.env.Launch(nil)
	var le *Error
	if !errors.As(err, &le) || !strings.Contains(le.Message, "无法启动") {
		t.Fatal(err)
	}
}

func TestPortableBootstrapAndMove(t *testing.T) {
	f := newFixture(t, "1.4.0")
	f.runner.byVer["1.4.0"] = behaviour{exitAfter: time.Minute + HealthTimeout}
	os.WriteFile(filepath.Join(f.env.Root, PortableFile), []byte(`{"channel":"beta"}`), 0o644)
	if _, err := f.env.Launch(nil); err != nil {
		t.Fatal(err)
	}
	r := f.read()
	if !r.Portable || r.Current != "1.4.0" || r.Channel != "beta" || r.DataRoot != filepath.Join(f.env.Root, "data") ||
		r.Root != f.env.Root || r.Confirmed || r.InstalledAt == "" {
		t.Fatalf("bootstrapped %+v", r)
	}
	// Move the folder: root and dataRoot follow.
	newRoot := filepath.Join(filepath.Dir(f.env.Root), "移动后")
	if err := os.Rename(f.env.Root, newRoot); err != nil {
		t.Fatal(err)
	}
	f.env.Root = newRoot
	r, err := f.env.Load()
	if err != nil {
		t.Fatal(err)
	}
	if r.Root != newRoot || r.DataRoot != filepath.Join(newRoot, "data") {
		t.Fatalf("rebased %+v", r)
	}
	// Two app folders and no record: portable.json's version decides; without one, refused.
	os.Remove(record.Path(newRoot))
	f.addApp("1.5.0")
	os.WriteFile(filepath.Join(newRoot, PortableFile), []byte(`{"schema":1,"version":"1.5.0"}`), 0o644)
	if r, err := f.env.Load(); err != nil || r.Current != "1.5.0" || r.Channel != "stable" {
		t.Fatalf("marker version: %+v %v", r, err)
	}
	os.Remove(record.Path(newRoot))
	os.WriteFile(filepath.Join(newRoot, PortableFile), []byte(`{"schema":1,"version":"9.9.9"}`), 0o644)
	if _, err := f.env.Load(); err == nil {
		t.Fatal("ambiguous portable folder must fail")
	}
}

func TestMovedInstallIsRebased(t *testing.T) {
	f := newFixture(t, "1.0.0")
	old := filepath.Join(filepath.Dir(f.env.Root), "旧位置")
	f.write(func(r *record.Record) { r.Root = old; r.DataRoot = filepath.Join(old, "data") })
	r, err := f.env.Load()
	if err != nil {
		t.Fatal(err)
	}
	if r.Root != f.env.Root || r.DataRoot != filepath.Join(f.env.Root, "data") || r.Portable {
		t.Fatalf("rebased %+v", r)
	}
	if got := f.read(); got.Root != f.env.Root || got.DataRoot != r.DataRoot {
		t.Fatalf("not written: %+v", got)
	}
	// A data root outside the old root (kept 1.0.x data, a custom folder) stays where it is.
	elsewhere := filepath.Join(filepath.Dir(f.env.Root), "我的数据")
	f.write(func(r *record.Record) { r.Root = old; r.DataRoot = elsewhere })
	r, err = f.env.Load()
	if err != nil || r.Root != f.env.Root || r.DataRoot != elsewhere {
		t.Fatalf("custom data root: %+v %v", r, err)
	}
}

func TestRestartWaitsForPidAndApps(t *testing.T) {
	f := newFixture(t, "1.0.0", "1.1.0")
	f.write(func(r *record.Record) { r.Pending = "1.1.0" })
	f.runner.byVer["1.1.0"] = behaviour{confirmAfter: HealthConfirm}
	f.procs = []proc.Info{{Pid: 77, Exe: filepath.Join(f.env.Root, "app-1.0.0", "MossStudio")}}
	f.clock.after(3*time.Second, func() { f.procs = nil }) // helpers linger 3s
	var waited int
	code, err := f.env.Restart(77, func(pid int, d time.Duration) bool { waited = pid; return true }, []string{"--a"})
	if err != nil || code != 0 || waited != 77 {
		t.Fatal(code, err, waited)
	}
	if r := f.read(); r.Current != "1.1.0" || r.Previous != "1.0.0" || !r.Confirmed {
		t.Fatalf("record %+v", r)
	}
	if got := f.startedVersions(); len(got) != 1 || got[0] != "1.1.0" {
		t.Fatalf("started %v", got)
	}
}

func TestUninstallStartsCurrentWithFlag(t *testing.T) {
	f := newFixture(t, "1.0.0", "1.1.0")
	f.write(func(r *record.Record) { r.Pending = "1.1.0" })
	if err := f.env.Uninstall([]string{SilentArg}); err != nil {
		t.Fatal(err)
	}
	s := f.runner.starts
	if len(s) != 1 || filepath.Base(filepath.Dir(s[0].exe)) != "app-1.0.0" || strings.Join(s[0].args, " ") != UninstallArg+" "+SilentArg {
		t.Fatalf("starts %+v", s)
	}
	if f.read().Pending != "1.1.0" {
		t.Error("uninstall must not switch versions")
	}
}

func TestUninstallWithoutRecordUsesNewestApp(t *testing.T) {
	for name, content := range map[string]string{"missing": "", "corrupt": "{oops"} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, "1.9.0", "1.10.0", "1.10.0-beta.2")
			if content != "" {
				os.WriteFile(record.Path(f.env.Root), []byte(content), 0o644)
			}
			if err := f.env.Uninstall([]string{SilentArg}); err != nil {
				t.Fatal(err)
			}
			if got := f.startedVersions(); len(got) != 1 || got[0] != "1.10.0" {
				t.Fatalf("started %v", got)
			}
		})
	}
	f := newFixture(t)
	if err := f.env.Uninstall(nil); err == nil {
		t.Fatal("no record and no app folder must be an error")
	}
}

func TestCompareSemver(t *testing.T) {
	ordered := []string{"1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.2.0", "1.10.0", "2.0.0"}
	for i := range ordered {
		for j := range ordered {
			want := compareInts(i, j)
			if got := CompareSemver(ordered[i], ordered[j]); got != want {
				t.Errorf("CompareSemver(%s, %s) = %d, want %d", ordered[i], ordered[j], got, want)
			}
		}
	}
	if NewestVersion([]string{"1.2.0", "1.10.0", "1.9.9"}) != "1.10.0" || NewestVersion(nil) != "" {
		t.Error("NewestVersion")
	}
}

// TestConstantsMatchContract keeps the Go mirrors in sync with shared/install.ts.
func TestConstantsMatchContract(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "apps", "desktop", "src", "shared", "install.ts"))
	if err != nil {
		t.Fatalf("contract not found: %v", err)
	}
	num := func(name string) time.Duration {
		m := regexp.MustCompile(`export const ` + name + ` = ([0-9_]+)`).FindSubmatch(src)
		if m == nil {
			t.Fatalf("%s not in install.ts", name)
		}
		n, _ := strconv.Atoi(strings.ReplaceAll(string(m[1]), "_", ""))
		return time.Duration(n) * time.Millisecond
	}
	str := func(name string) string {
		m := regexp.MustCompile(`export const ` + name + ` = '([^']+)'`).FindSubmatch(src)
		if m == nil {
			t.Fatalf("%s not in install.ts", name)
		}
		return string(m[1])
	}
	if num("HEALTH_CONFIRM_MS") != HealthConfirm || num("HEALTH_TIMEOUT_MS") != HealthTimeout {
		t.Error("health constants differ from install.ts")
	}
	for name, want := range map[string]string{"SETUP_ARG": SetupArg, "SILENT_ARG": SilentArg, "INSTALL_TO_ARG": InstallToArg,
		"LAUNCHED_ARG": LaunchedArg, "UNINSTALL_ARG": UninstallArg, "FINISH_UNINSTALL_ARG": FinishUninstallArg} {
		if got := str(name); got != want {
			t.Errorf("%s = %q in install.ts, %q in Go", name, got, want)
		}
	}
	for _, env := range []string{EnvRoot, EnvLauncher} {
		if !strings.Contains(string(src), env+"=") {
			t.Errorf("%s not documented in install.ts", env)
		}
	}
}
