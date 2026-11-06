// Package uninstall implements `--finish-uninstall=<plan.json>`: after the app has quit,
// a temporary copy of the launcher deletes exactly what the app's uninstall plan lists.
//
// # Plan file
//
// The app writes the plan; its shape is uninstallPlanSchema in
// apps/desktop/src/shared/install.ts (unknown keys are ignored):
//
//	{
//	  "schema": 1,
//	  "platform": "win32-x64" | "linux-x64",
//	  "root": "<R, absolute>",
//	  "dataRoot": "<data root, absolute>",
//	  "removeData": false,              // true: dataRoot itself is in remove
//	  "remove": ["<absolute>", ...],    // files or folders, deleted in order, recursively; missing ones skipped
//	  "registryKeys": ["HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MossStudio"],
//	  "removeEmptyDirs": ["<R>", "<locator folder>"], // removed afterwards only when empty
//	  "profileDir": "<Electron userData>", // optional, only with removeData: deleted recursively
//	  "createdAt": "<ISO time>"
//	}
//
// Rules, all checked before anything is deleted (one violation refuses the whole plan):
//   - platform is this OS's key; root and dataRoot are absolute, not a drive or filesystem
//     root, not a system folder (the same list as location.ts locationRule: Windows,
//     Program Files, the home folder, AppData and its Local/Roaming/Programs, Desktop,
//     Documents, Downloads, ~/.config, ~/.local/share, /usr, /etc, …), do not contain the
//     home folder, and dataRoot is neither root nor above it.
//   - root is a real install: its install.json parses and names the same root and dataRoot;
//     or its portable.json parses and dataRoot is root/data; or install.json is missing or
//     damaged, root holds the launcher and an app-<v> folder, and dataRoot is root/data.
//   - each remove entry is one of: a direct child of root with a name the install owns
//     (app-<v>[.partial|.partial.delta|.update-partial|.update-partial.delta|.replaced-*], .updates,
//     .moss-legacy-*, .moss-trash-*, the launcher and its
//     .old-*/.new-* leftovers, install.json, portable.json); dataRoot itself, only with
//     removeData; or one of the exact integration files the launcher computes (Locations:
//     Start menu and Desktop MossStudio.lnk, the XDG .desktop entry and icon, the locator).
//     With removeData false, no entry may be dataRoot or above it.
//   - with removeData, dataRoot holds settings.json, instances/ or models/ (or is missing, or
//     holds only logs/).
//   - each registry key is exactly HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\MossStudio.
//   - each removeEmptyDirs entry is root, dataRoot or the computed locator folder.
//   - profileDir, when present: removeData is true, it equals the OS profile folder the
//     launcher computes itself (ProfileDir: Windows %APPDATA%\MossStudio, else the Roaming
//     known folder; Linux ${XDG_CONFIG_HOME:-~/.config}/MossStudio), it is not root, inside
//     root or above root, and it is not a drive root and does not contain HOME.
//   - the launcher running the plan is not inside root (the app runs a temp copy).
//
// # Sequence
//
// Wait until no process runs from root (up to WaitTimeout; on timeout nothing is deleted),
// delete the remove entries, then profileDir, delete the registry keys with reg.exe (argument array), remove
// the removeEmptyDirs that are empty, then delete the plan file and the launcher copy itself
// (Windows: a delayed cmd.exe; Linux: unlink) and their MossStudio-uninstall-* folder.
package uninstall

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/CloverIris/MossStudio/launcher/internal/fsutil"
	"github.com/CloverIris/MossStudio/launcher/internal/proc"
)

// RegistryKey is the only key a plan may remove.
const RegistryKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\MossStudio`

// TempDirPrefix names the dedicated folder the app copies the launcher into.
const TempDirPrefix = "MossStudio-uninstall-"

// WaitTimeout bounds the wait for the app's processes to exit.
const WaitTimeout = 2 * time.Minute

// Plan is the uninstall plan file (uninstallPlanSchema).
type Plan struct {
	Schema          int      `json:"schema"`
	Platform        string   `json:"platform"`
	Root            string   `json:"root"`
	DataRoot        string   `json:"dataRoot"`
	RemoveData      *bool    `json:"removeData"`
	Remove          []string `json:"remove"`
	RegistryKeys    []string `json:"registryKeys"`
	RemoveEmptyDirs []string `json:"removeEmptyDirs"`
	ProfileDir      string   `json:"profileDir,omitempty"`
	CreatedAt       string   `json:"createdAt"`
}

// ReadPlan loads a plan file.
func ReadPlan(path string) (*Plan, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	data = []byte(strings.TrimPrefix(string(data), "\xef\xbb\xbf"))
	var p Plan
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("uninstall plan %s: %w", path, err)
	}
	return &p, nil
}

// PlatformKey is the plan platform this build executes.
func PlatformKey() string {
	if runtime.GOOS == "windows" {
		return "win32-x64"
	}
	return "linux-x64"
}

// Checker validates a plan; the fields are injectable for tests (DefaultChecker fills them).
type Checker struct {
	Home     string // user's home folder; "" skips the home checks
	Fold     bool   // compare paths case-insensitively
	Launcher string // this executable
	Platform string // expected plan platform; "" = PlatformKey()
	// Profile is the Electron profile folder computed for this user (see ProfileDir);
	// "" means none can be computed, so a plan with profileDir is refused.
	Profile   string
	Locations Locations
	Getenv    func(string) string // for the system folder list; nil = os.Getenv
}

func (c Checker) platform() string {
	if c.Platform != "" {
		return c.Platform
	}
	return PlatformKey()
}

func isVolumeRoot(p string) bool {
	p = filepath.Clean(p)
	return filepath.Dir(p) == p
}

// Validate applies every rule from the package doc. It reads install.json/portable.json in
// root, lists the data root, and refuses integration "files" that are folders.
func (c Checker) Validate(p *Plan) error {
	want := c.platform()
	switch {
	case p.Schema != 1:
		return fmt.Errorf("plan schema %d is not 1", p.Schema)
	case p.Platform != want:
		return fmt.Errorf("plan platform %q is not %s", p.Platform, want)
	case p.RemoveData == nil:
		return errors.New("plan has no removeData")
	case p.Remove == nil:
		return errors.New("plan has no remove list")
	}
	removeData := *p.RemoveData
	for _, f := range []struct{ name, dir string }{{"root", p.Root}, {"dataRoot", p.DataRoot}} {
		switch {
		case f.dir == "" || !filepath.IsAbs(f.dir):
			return fmt.Errorf("%s %q is not absolute", f.name, f.dir)
		case isVolumeRoot(f.dir):
			return fmt.Errorf("%s %q is a drive or filesystem root", f.name, f.dir)
		case c.Home != "" && fsutil.Inside(f.dir, c.Home, c.Fold):
			return fmt.Errorf("%s %q contains the home folder", f.name, f.dir)
		}
		if sys := c.systemFolderProblem(f.dir); sys != "" {
			return fmt.Errorf("%s %q is the system folder %s or inside it", f.name, f.dir, sys)
		}
	}
	if fsutil.Inside(p.DataRoot, p.Root, c.Fold) {
		return fmt.Errorf("dataRoot %q is root or above it", p.DataRoot)
	}
	if c.Launcher != "" && fsutil.Inside(p.Root, c.Launcher, c.Fold) {
		return errors.New("--finish-uninstall must run from a copy of the launcher outside the install folder")
	}
	if problem := c.installEvidence(p); problem != "" {
		return fmt.Errorf("%s is not a MossStudio install: %s", p.Root, problem)
	}
	if removeData {
		if problem := dataProblem(p.DataRoot); problem != "" {
			return fmt.Errorf("data folder %s cannot be deleted: %s", p.DataRoot, problem)
		}
	}
	for _, path := range p.Remove {
		if path == "" || !filepath.IsAbs(path) {
			return fmt.Errorf("remove entry %q is not absolute", path)
		}
		if !removeData && fsutil.Inside(path, p.DataRoot, c.Fold) {
			return fmt.Errorf("remove entry %q is or holds the data folder, which is kept", path)
		}
		clean := filepath.Clean(path)
		switch {
		case removeData && fsutil.SamePath(clean, p.DataRoot, c.Fold):
		case fsutil.SamePath(filepath.Dir(clean), p.Root, c.Fold) && ownedRootName(want, filepath.Base(clean), c.Fold):
		case c.isIntegrationFile(clean):
			if st, err := os.Lstat(clean); err == nil && st.IsDir() {
				return fmt.Errorf("remove entry %q should be a shortcut, icon or locator file but is a folder", path)
			}
		default:
			return fmt.Errorf("remove entry %q is not an install-owned entry of root, the data folder or a MossStudio shortcut/locator file", path)
		}
	}
	if p.ProfileDir != "" {
		d := p.ProfileDir
		base := filepath.Base(filepath.Clean(d))
		switch {
		case !removeData:
			return errors.New("profileDir is only allowed when removeData is true")
		case !filepath.IsAbs(d) || !(base == "MossStudio" || c.Fold && strings.EqualFold(base, "MossStudio")):
			return fmt.Errorf("profileDir %q is not an absolute …/MossStudio folder", d)
		case c.Profile == "" || !filepath.IsAbs(c.Profile) || !fsutil.SamePath(d, c.Profile, c.Fold):
			return fmt.Errorf("profileDir %q is not this user's MossStudio profile folder (%q)", d, c.Profile)
		case isVolumeRoot(d) || c.Home != "" && fsutil.Inside(d, c.Home, c.Fold):
			return fmt.Errorf("profileDir %q is a drive root or contains the home folder", d)
		case fsutil.Inside(p.Root, d, c.Fold) || fsutil.Inside(d, p.Root, c.Fold):
			return fmt.Errorf("profileDir %q is the install folder, inside it or above it", d)
		}
	}
	for _, k := range p.RegistryKeys {
		if !strings.EqualFold(k, RegistryKey) {
			return fmt.Errorf("registry key %q is not %s", k, RegistryKey)
		}
	}
	for _, d := range p.RemoveEmptyDirs {
		ok := filepath.IsAbs(d) && (fsutil.SamePath(d, p.Root, c.Fold) || fsutil.SamePath(d, p.DataRoot, c.Fold) ||
			c.Locations.LocatorDir != "" && fsutil.SamePath(d, c.Locations.LocatorDir, c.Fold))
		if !ok {
			return fmt.Errorf("removeEmptyDirs entry %q is not root, dataRoot or the locator folder", d)
		}
	}
	return nil
}

// Runner executes a validated plan; the hooks are injectable for tests.
type Runner struct {
	Running      func(root string) ([]proc.Info, error)
	Sleep        func(time.Duration)
	Now          func() time.Time
	DeleteRegKey func(key string) error
	Logf         func(format string, args ...any)
}

func (r *Runner) logf(format string, args ...any) {
	if r.Logf != nil {
		r.Logf(format, args...)
	}
}

// ErrStillRunning means MossStudio did not exit in time; nothing was deleted.
var ErrStillRunning = errors.New("MossStudio is still running")

// Execute waits for the app to exit and deletes what the plan lists. The returned error
// lists every item that could not be removed.
func (r *Runner) Execute(p *Plan) error {
	deadline := r.Now().Add(WaitTimeout)
	for {
		list, err := r.Running(p.Root)
		if err != nil {
			return fmt.Errorf("cannot list processes: %w", err)
		}
		if len(list) == 0 {
			break
		}
		if !r.Now().Before(deadline) {
			return fmt.Errorf("%w (pid %d: %s)", ErrStillRunning, list[0].Pid, list[0].Exe)
		}
		r.Sleep(250 * time.Millisecond)
	}
	var failed []string
	for _, path := range p.Remove {
		if err := r.removeAll(path); err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v", path, err))
		}
	}
	if p.ProfileDir != "" {
		if err := r.removeAll(p.ProfileDir); err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v", p.ProfileDir, err))
		}
	}
	if r.DeleteRegKey != nil {
		for _, k := range p.RegistryKeys {
			if err := r.DeleteRegKey(k); err != nil {
				failed = append(failed, fmt.Sprintf("%s: %v", k, err))
			}
		}
	}
	for _, d := range p.RemoveEmptyDirs {
		os.Remove(d) // only succeeds when empty: nothing else is touched
	}
	if len(failed) > 0 {
		return fmt.Errorf("could not remove: %s", strings.Join(failed, "; "))
	}
	return nil
}

// removeAll deletes path, retrying for a few seconds while Windows still holds files open.
func (r *Runner) removeAll(path string) error {
	var err error
	for i := 0; i < 20; i++ {
		if err = os.RemoveAll(path); err == nil {
			r.logf("removed %s", path)
			return nil
		}
		if runtime.GOOS != "windows" {
			return err
		}
		r.Sleep(250 * time.Millisecond)
	}
	return err
}

// SelfCleanup lists what to delete after the plan ran: the plan file and the launcher copy,
// and their folder when it is a dedicated MossStudio-uninstall-* temp folder. Folders are
// compared after resolving symlinks and, on Windows, expanding 8.3 short names (a temp
// path like C:\Users\LONGNA~1\AppData\Local\Temp names the same folder as the long form).
func SelfCleanup(launcher, planPath string) (files []string, dir string) {
	ldir := canonicalPath(filepath.Dir(launcher))
	if fsutil.SamePath(canonicalPath(filepath.Dir(planPath)), ldir, fsutil.FoldCase) {
		files = append(files, planPath)
	}
	files = append(files, launcher)
	if strings.HasPrefix(strings.ToLower(filepath.Base(ldir)), strings.ToLower(TempDirPrefix)) {
		dir = ldir
	}
	return files, dir
}

// canonicalPath resolves symlinks (when the path exists) and expands short names.
func canonicalPath(p string) string {
	if abs, err := filepath.Abs(p); err == nil {
		p = abs
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return longPath(p)
}

// cmdSafe reports whether s can be quoted for cmd.exe without any of its characters being
// interpreted (cmd expands % even inside quotes; " cannot be escaped).
func cmdSafe(s string) bool {
	return s != "" && !strings.ContainsAny(s, "\"%\r\n\x00")
}

// cmdTokens are the fixed words WindowsSelfDeleteArgs emits; everything else is a path.
var cmdTokens = map[string]bool{"/d": true, "/q": true, "/v:off": true, "/c": true, "ping": true, "-n": true, "3": true,
	"127.0.0.1": true, ">NUL": true, "&": true, "del": true, "/f": true, "rmdir": true}

// WindowsSelfDeleteArgs returns cmd.exe's arguments (/d no AutoRun, /v:off no delayed
// expansion) that wait ~2 s (until this process has exited) and then delete files and the empty folder dir. ok is false if a path cannot be
// passed to cmd.exe safely.
func WindowsSelfDeleteArgs(files []string, dir string) (args []string, ok bool) {
	args = []string{"/d", "/q", "/v:off", "/c", "ping", "-n", "3", "127.0.0.1", ">NUL"}
	for _, f := range files {
		if !cmdSafe(f) {
			return nil, false
		}
		args = append(args, "&", "del", "/f", "/q", f)
	}
	if dir != "" {
		if !cmdSafe(dir) {
			return nil, false
		}
		args = append(args, "&", "rmdir", dir)
	}
	return args, true
}

// WindowsCmdLine joins cmd.exe and args into the exact command line: the fixed tokens raw,
// every path in double quotes (inside which cmd treats & | < > ^ and spaces literally).
func WindowsCmdLine(cmdExe string, args []string) string {
	parts := []string{`"` + cmdExe + `"`}
	for _, a := range args {
		if cmdTokens[a] {
			parts = append(parts, a)
		} else {
			parts = append(parts, `"`+a+`"`)
		}
	}
	return strings.Join(parts, " ")
}
