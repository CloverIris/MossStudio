package uninstall

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/CloverIris/MossStudio/apps/launcher/internal/proc"
	"github.com/CloverIris/MossStudio/apps/launcher/internal/record"
)

type world struct {
	base, home, root, data, desktop, cfg string
}

func newWorld(t *testing.T) world {
	t.Helper()
	base := t.TempDir()
	w := world{
		base:    base,
		home:    filepath.Join(base, "home", "张三"),
		root:    filepath.Join(base, "home", "张三", "Programs", "Moss Studio"),
		desktop: filepath.Join(base, "home", "张三", "Desktop"),
		cfg:     filepath.Join(base, "home", "张三", ".config", "MossStudio"),
	}
	w.data = filepath.Join(w.root, "data")
	for _, d := range []string{
		filepath.Join(w.root, "app-1.0.0", "resources"), filepath.Join(w.root, "app-1.1.0"),
		filepath.Join(w.data, "works"), w.desktop, w.cfg,
	} {
		mustT(t, os.MkdirAll(d, 0o755))
	}
	for _, f := range []string{
		filepath.Join(w.root, "app-1.0.0", "MossStudio"), filepath.Join(w.root, "app-1.0.0", "resources", "app.asar"),
		filepath.Join(w.root, "app-1.1.0", "MossStudio"), filepath.Join(w.root, "mossstudio"),
		filepath.Join(w.data, "works", "作品.png"), filepath.Join(w.data, "settings.json"),
		filepath.Join(w.desktop, "MossStudio.desktop"), filepath.Join(w.cfg, "locator.json"),
		filepath.Join(w.desktop, "other.txt"),
	} {
		mustT(t, os.WriteFile(f, []byte("x"), 0o644))
	}
	w.writeRecord(t, w.root, w.data)
	return w
}

// writeRecord writes a valid install.json into the world's root.
func (w world) writeRecord(t *testing.T, root, data string) {
	t.Helper()
	r := &record.Record{Schema: 1, Platform: PlatformKey(), Root: root, DataRoot: data, Channel: "stable",
		Current: "1.1.0", Failed: []string{}, InstalledAt: "x", UpdatedAt: "x"}
	mustT(t, record.Write(record.Path(w.root), r))
}

func mustT(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func (w world) plan(withData bool) *Plan {
	rd := withData
	p := &Plan{
		Schema: 1, Platform: PlatformKey(), Root: w.root, DataRoot: w.data, RemoveData: &rd,
		Remove: []string{
			filepath.Join(w.root, "app-1.0.0"), filepath.Join(w.root, "app-1.1.0"),
			filepath.Join(w.root, "mossstudio"), filepath.Join(w.root, "install.json"),
			filepath.Join(w.root, "portable.json"), // absent: skipped
			filepath.Join(w.desktop, "MossStudio.desktop"), filepath.Join(w.cfg, "locator.json"),
		},
		RemoveEmptyDirs: []string{w.root, w.cfg},
		CreatedAt:       "2026-01-01T00:00:00.000Z",
	}
	if withData {
		p.Remove = append(p.Remove, w.data)
	}
	return p
}

func (w world) checker() Checker {
	return Checker{
		Home: w.home, Fold: runtime.GOOS == "windows", Launcher: filepath.Join(w.base, "tmp", TempDirPrefix+"x", "mossstudio"),
		Locations: Locations{
			Integration: []string{filepath.Join(w.desktop, "MossStudio.desktop"), filepath.Join(w.cfg, "locator.json")},
			LocatorDir:  w.cfg,
		},
		Getenv: func(string) string { return "" },
	}
}

func runner(running func() []proc.Info) (*Runner, *time.Time) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	r := &Runner{
		Running: func(string) ([]proc.Info, error) { return running(), nil },
		Sleep:   func(d time.Duration) { now = now.Add(d) },
		Now:     func() time.Time { return now },
	}
	return r, &now
}

func TestExecuteKeepsDataByDefault(t *testing.T) {
	w := newWorld(t)
	p := w.plan(false)
	mustT(t, w.checker().Validate(p))
	var regKey string
	r, _ := runner(func() []proc.Info { return nil })
	r.DeleteRegKey = func(k string) error { regKey = k; return nil }
	p.RegistryKeys = []string{RegistryKey}
	mustT(t, r.Execute(p))
	for _, gone := range []string{filepath.Join(w.root, "app-1.0.0"), filepath.Join(w.root, "mossstudio"), filepath.Join(w.desktop, "MossStudio.desktop"), w.cfg} {
		if _, err := os.Lstat(gone); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s should be gone", gone)
		}
	}
	for _, kept := range []string{filepath.Join(w.data, "works", "作品.png"), filepath.Join(w.desktop, "other.txt")} {
		if _, err := os.Stat(kept); err != nil {
			t.Errorf("%s must be kept: %v", kept, err)
		}
	}
	if regKey != RegistryKey {
		t.Errorf("registry key %q", regKey)
	}
}

func TestExecuteWithDataRemovesEmptyRootOnly(t *testing.T) {
	w := newWorld(t)
	p := w.plan(true)
	mustT(t, w.checker().Validate(p))
	r, _ := runner(func() []proc.Info { return nil })
	mustT(t, r.Execute(p))
	if _, err := os.Stat(w.root); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("empty root should be removed")
	}
	// A stray user file in R keeps R (nothing unlisted is deleted).
	w2 := newWorld(t)
	stray := filepath.Join(w2.root, "我的笔记.txt")
	mustT(t, os.WriteFile(stray, []byte("keep"), 0o644))
	r2, _ := runner(func() []proc.Info { return nil })
	mustT(t, r2.Execute(w2.plan(true)))
	if _, err := os.Stat(stray); err != nil {
		t.Fatal("unlisted file in R was deleted")
	}
}

func TestExecuteWaitsForProcesses(t *testing.T) {
	w := newWorld(t)
	calls := 0
	r, now := runner(func() []proc.Info {
		calls++
		if calls < 5 {
			return []proc.Info{{Pid: 9, Exe: filepath.Join(w.root, "app-1.1.0", "MossStudio")}}
		}
		return nil
	})
	start := *now
	mustT(t, r.Execute(w.plan(false)))
	if now.Sub(start) < time.Second {
		t.Fatalf("did not wait (%v)", now.Sub(start))
	}
}

func TestExecuteTimeoutDeletesNothing(t *testing.T) {
	w := newWorld(t)
	r, _ := runner(func() []proc.Info { return []proc.Info{{Pid: 9, Exe: filepath.Join(w.root, "mossstudio")}} })
	err := r.Execute(w.plan(true))
	if !errors.Is(err, ErrStillRunning) {
		t.Fatalf("want ErrStillRunning, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(w.root, "app-1.0.0")); err != nil {
		t.Fatal("nothing may be deleted when the app does not exit")
	}
}

func TestValidateRefusals(t *testing.T) {
	w := newWorld(t)
	c := w.checker()
	add := func(path string) func(p *Plan) { return func(p *Plan) { p.Remove = append(p.Remove, path) } }
	mustT(t, os.Mkdir(filepath.Join(w.desktop, "MossStudio.lnk"), 0o755))
	// name → (mutation, expected error fragment)
	cases := map[string]struct {
		mut  func(p *Plan)
		want string
	}{
		"schema":               {func(p *Plan) { p.Schema = 2 }, "schema"},
		"other platform":       {func(p *Plan) { p.Platform = "darwin-arm64" }, "platform"},
		"no removeData":        {func(p *Plan) { p.RemoveData = nil }, "removeData"},
		"no remove":            {func(p *Plan) { p.Remove = nil }, "remove list"},
		"relative root":        {func(p *Plan) { p.Root = "Programs/MossStudio" }, "not absolute"},
		"fs root":              {func(p *Plan) { p.Root = string(filepath.Separator) }, "filesystem root"},
		"root holds home":      {func(p *Plan) { p.Root = filepath.Dir(w.home) }, "home folder"},
		"root is .config":      {func(p *Plan) { p.Root = filepath.Join(w.home, ".config") }, "system folder"},
		"root is Downloads":    {func(p *Plan) { p.Root = filepath.Join(w.home, "Downloads") }, "system folder"},
		"root in /usr":         {func(p *Plan) { p.Root = "/usr/local/MossStudio" }, "system folder"},
		"data is .local/share": {func(p *Plan) { p.DataRoot = filepath.Join(w.home, ".local", "share") }, "system folder"},
		"data is Documents":    {func(p *Plan) { p.DataRoot = filepath.Join(w.home, "Documents") }, "system folder"},
		"data in /etc":         {func(p *Plan) { p.DataRoot = "/etc/moss" }, "system folder"},
		"data is home":         {func(p *Plan) { p.DataRoot = w.home }, "home folder"},
		"data above root":      {func(p *Plan) { p.DataRoot = filepath.Dir(w.root) }, "above it"},
		"data equals root":     {func(p *Plan) { p.DataRoot = w.root }, "above it"},
		"record data differs":  {func(p *Plan) { p.DataRoot = filepath.Join(w.home, "Elsewhere") }, "not a MossStudio install"},
		"entry is root":        {add(w.root), "not an install-owned"},
		"entry outside":        {add(filepath.Join(w.home, "Documents")), "not an install-owned"},
		"entry not owned":      {add(filepath.Join(w.root, "我的笔记.txt")), "not an install-owned"},
		"entry nested":         {add(filepath.Join(w.root, "app-1.0.0", "resources")), "not an install-owned"},
		"entry in data":        {add(filepath.Join(w.data, "works")), "not an install-owned"},
		"dotdot escape":        {add(w.root + string(filepath.Separator) + ".." + string(filepath.Separator) + "x"), "not an install-owned"},
		"relative entry":       {add("app-1.0.0"), "not absolute"},
		"empty entry":          {add(""), "not absolute"},
		"sibling prefix":       {add(w.root + "-old"), "not an install-owned"},
		"shortcut elsewhere":   {add(filepath.Join(w.home, "MossStudio.desktop")), "not an install-owned"},
		"shortcut other name":  {add(filepath.Join(w.desktop, "other.desktop")), "not an install-owned"},
		"shortcut folder":      {add(filepath.Join(w.desktop, "MossStudio.lnk")), "not an install-owned"},
		"locator elsewhere":    {add(filepath.Join(w.home, "MossStudio", "locator.json")), "not an install-owned"},
		"registry key":         {func(p *Plan) { p.RegistryKeys = []string{`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`} }, "registry key"},
		"registry nested":      {func(p *Plan) { p.RegistryKeys = []string{RegistryKey + `\..\Other`} }, "registry key"},
		"empty dir outside":    {func(p *Plan) { p.RemoveEmptyDirs = append(p.RemoveEmptyDirs, w.home) }, "removeEmptyDirs"},
		"empty dir other MossStudio": {func(p *Plan) {
			p.RemoveEmptyDirs = append(p.RemoveEmptyDirs, filepath.Join(w.home, "Documents", "MossStudio"))
		}, "removeEmptyDirs"},
	}
	for name, cs := range cases {
		p := w.plan(true)
		cs.mut(p)
		err := c.Validate(p)
		if err == nil || !strings.Contains(err.Error(), cs.want) {
			t.Errorf("%s: want an error containing %q, got %v", name, cs.want, err)
		}
	}
	// While the data is kept, neither the data folder nor anything holding it may be listed.
	for name, mut := range map[string]func(p *Plan){
		"kept data listed": add(w.data),
		"kept data parent": add(filepath.Dir(w.data)),
	} {
		p := w.plan(false)
		mut(p)
		if err := c.Validate(p); err == nil {
			t.Errorf("%s: plan should be refused", name)
		}
	}
	// Running the plan from inside R is refused.
	cc := c
	cc.Launcher = filepath.Join(w.root, "mossstudio")
	if err := cc.Validate(w.plan(false)); err == nil {
		t.Error("launcher inside root must be refused")
	}
}

func TestValidateAcceptsOwnedLeftovers(t *testing.T) {
	w := newWorld(t)
	p := w.plan(false)
	for _, name := range []string{"app-1.2.0.partial", "app-1.2.0-beta.1.replaced-1a2b", ".moss-legacy-9f", ".moss-trash-app-0.9.0-deadbeef",
		"mossstudio.old-123", ".mossstudio.new-77", "portable.json",
		".updates", "app-1.2.0.partial.delta", "app-1.2.0-rc.1.update-partial", "app-1.3.0.update-partial.delta"} {
		p.Remove = append(p.Remove, filepath.Join(w.root, name))
	}
	mustT(t, w.checker().Validate(p))
}

func TestOwnedRootName(t *testing.T) {
	for _, name := range []string{".updates", "app-1.2.0.partial.delta", "app-1.2.0.update-partial", "app-1.2.0.update-partial.delta",
		"app-1.2.0.partial", "app-1.2.0.replaced-1a2b"} {
		if !ownedRootName("linux-x64", name, false) {
			t.Errorf("%s should be owned", name)
		}
	}
	for _, name := range []string{".updates-old", "updates", "app-1.2.0.delta", "app-1.2.0.partial.delta.x", "app-1.2.update-partial",
		"app-1.2.0.update-partial.delta.tmp", "app-1.2.0.delta.partial", "app-1.2.0.replaced-", "data", "我的笔记.txt", ".UPDATES"} {
		if ownedRootName("linux-x64", name, false) {
			t.Errorf("%s must not be owned", name)
		}
	}
	if !ownedRootName("win32-x64", ".Updates", true) || !ownedRootName("win32-x64", "App-1.0.0.Partial.Delta", true) {
		t.Error("Windows names compare case-insensitively")
	}
}

func TestValidateRequiresInstallEvidence(t *testing.T) {
	w := newWorld(t)
	c := w.checker()
	// install.json deleted, launcher and app folders present, default data root: accepted
	// (Apps & Features uninstall still works after the record is lost).
	mustT(t, os.Remove(record.Path(w.root)))
	mustT(t, c.Validate(w.plan(false)))
	mustT(t, c.Validate(w.plan(true)))
	pc := w.plan(false)
	pc.DataRoot = filepath.Join(w.home, "MossData")
	if err := c.Validate(pc); err == nil || !strings.Contains(err.Error(), "not a MossStudio install") {
		t.Fatalf("missing record cannot vouch for a custom data root: %v", err)
	}
	// No record, no portable.json, no launcher: refused.
	mustT(t, os.Rename(filepath.Join(w.root, "mossstudio"), filepath.Join(w.root, "mossstudio.away")))
	if err := c.Validate(w.plan(false)); err == nil || !strings.Contains(err.Error(), "not a MossStudio install") {
		t.Fatalf("no evidence: %v", err)
	}
	mustT(t, os.Rename(filepath.Join(w.root, "mossstudio.away"), filepath.Join(w.root, "mossstudio")))
	// No record and no app folder: refused.
	for _, v := range []string{"app-1.0.0", "app-1.1.0"} {
		mustT(t, os.Rename(filepath.Join(w.root, v), filepath.Join(w.root, v+".update-partial")))
	}
	if err := c.Validate(w.plan(false)); err == nil {
		t.Fatal("no app folder must be refused")
	}
	for _, v := range []string{"app-1.0.0", "app-1.1.0"} {
		mustT(t, os.Rename(filepath.Join(w.root, v+".update-partial"), filepath.Join(w.root, v)))
	}
	// A record naming another root: refused.
	w.writeRecord(t, filepath.Join(w.home, "Other"), w.data)
	if err := c.Validate(w.plan(false)); err == nil {
		t.Fatal("record for another root must be refused")
	}
	// Portable marker with the default data root: accepted.
	mustT(t, os.Remove(record.Path(w.root)))
	mustT(t, os.WriteFile(filepath.Join(w.root, "portable.json"), []byte(`{"schema":1,"version":"1.1.0"}`), 0o644))
	mustT(t, c.Validate(w.plan(false)))
	// A bad portable marker is not evidence on its own (without the launcher to fall back on).
	mustT(t, os.WriteFile(filepath.Join(w.root, "portable.json"), []byte(`{"schema":1}`), 0o644))
	mustT(t, os.Rename(filepath.Join(w.root, "mossstudio"), filepath.Join(w.root, "mossstudio.away")))
	if err := c.Validate(w.plan(false)); err == nil {
		t.Fatal("invalid portable.json must not count")
	}
	mustT(t, os.Rename(filepath.Join(w.root, "mossstudio.away"), filepath.Join(w.root, "mossstudio")))
	// Damaged install.json, launcher and app folder present, default data root: accepted.
	mustT(t, os.Remove(filepath.Join(w.root, "portable.json")))
	mustT(t, os.WriteFile(record.Path(w.root), []byte("{broken"), 0o644))
	mustT(t, c.Validate(w.plan(false)))
	// ...but not with a data root elsewhere, nor without the launcher.
	p := w.plan(false)
	p.DataRoot = filepath.Join(w.home, "MossData")
	if err := c.Validate(p); err == nil {
		t.Fatal("damaged record cannot vouch for a custom data root")
	}
	mustT(t, os.Remove(filepath.Join(w.root, "mossstudio")))
	if err := c.Validate(w.plan(false)); err == nil {
		t.Fatal("damaged record without the launcher must be refused")
	}
}

func TestValidateDataMarker(t *testing.T) {
	w := newWorld(t)
	c := w.checker()
	mustT(t, os.Remove(filepath.Join(w.data, "settings.json")))
	if err := c.Validate(w.plan(true)); err == nil || !strings.Contains(err.Error(), "does not look like MossStudio data") {
		t.Fatalf("unmarked data folder: %v", err)
	}
	for _, marker := range []string{"instances", "models"} {
		mustT(t, os.Mkdir(filepath.Join(w.data, marker), 0o755))
		mustT(t, c.Validate(w.plan(true)))
		mustT(t, os.Remove(filepath.Join(w.data, marker)))
	}
	// Missing, or only the launcher's logs: nothing of the user's at stake.
	mustT(t, os.RemoveAll(w.data))
	mustT(t, os.MkdirAll(filepath.Join(w.data, "logs"), 0o755))
	mustT(t, c.Validate(w.plan(true)))
	mustT(t, os.RemoveAll(w.data))
	mustT(t, c.Validate(w.plan(true)))
	// Keeping the data needs no marker.
	mustT(t, c.Validate(w.plan(false)))
}

func TestSystemFoldersWindows(t *testing.T) {
	env := map[string]string{"SystemRoot": `D:\Windows`, "ProgramFiles": `D:\Program Files`, "LOCALAPPDATA": `D:\Users\张三\AppData\Local`}
	within, exact := systemFolders("win32-x64", `D:\Users\张三`, func(k string) string { return env[k] })
	join := strings.Join(within, "|") + "||" + strings.Join(exact, "|")
	for _, want := range []string{`D:\Windows`, `D:\Program Files (x86)`, `D:\ProgramData`, `D:\$Recycle.Bin`, `D:\Users`,
		`AppData`, `Desktop`, `Documents`, `Downloads`, `D:\Users\张三\AppData\Local`} {
		if !strings.Contains(join, want) {
			t.Errorf("Windows system folders lack %s: %s", want, join)
		}
	}
}

func TestReadPlan(t *testing.T) {
	w := newWorld(t)
	path := filepath.Join(w.base, "plan.json")
	mustT(t, os.WriteFile(path, []byte("\xef\xbb\xbf"+`{"schema":1,"platform":"linux-x64","root":"/a/b","dataRoot":"/a/b/data","removeData":false,"remove":[],"registryKeys":[],"removeEmptyDirs":[],"createdAt":"x","extra":true}`), 0o644))
	p, err := ReadPlan(path)
	if err != nil || p.Root != "/a/b" || p.Schema != 1 || p.RemoveData == nil || *p.RemoveData {
		t.Fatal(p, err)
	}
	mustT(t, os.WriteFile(path, []byte(`{`), 0o644))
	if _, err := ReadPlan(path); err == nil {
		t.Fatal("bad JSON must fail")
	}
}

func TestSelfCleanup(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, TempDirPrefix+"abc")
	mustT(t, os.MkdirAll(dir, 0o755))
	files, d := SelfCleanup(filepath.Join(dir, "mossstudio"), filepath.Join(dir, "plan.json"))
	if len(files) != 2 || d != canonicalPath(dir) {
		t.Fatal(files, d)
	}
	// The plan reached through another spelling of the same folder (a symlink, as an 8.3
	// short name is on Windows) is still recognised.
	alias := filepath.Join(base, "alias")
	if runtime.GOOS != "windows" {
		mustT(t, os.Symlink(dir, alias))
		files, d = SelfCleanup(filepath.Join(dir, "mossstudio"), filepath.Join(alias, "plan.json"))
		if len(files) != 2 || d == "" {
			t.Fatalf("aliased plan folder: %v %q", files, d)
		}
	}
	files, d = SelfCleanup(filepath.Join(base, "other", "mossstudio"), filepath.Join(base, "somewhere", "plan.json"))
	if len(files) != 1 || d != "" {
		t.Fatal(files, d)
	}
}

func TestWindowsSelfDeleteCommandLine(t *testing.T) {
	exe := `C:\Users\Tom & 张三\AppData\Local\Temp\MossStudio-uninstall-1\MossStudio.exe`
	dir := `C:\Users\Tom & 张三\AppData\Local\Temp\MossStudio-uninstall-1`
	args, ok := WindowsSelfDeleteArgs([]string{exe}, dir)
	if !ok {
		t.Fatal("should be safe")
	}
	line := WindowsCmdLine(`C:\Windows\System32\cmd.exe`, args)
	want := `"C:\Windows\System32\cmd.exe" /d /q /v:off /c ping -n 3 127.0.0.1 >NUL & del /f /q "` + exe + `" & rmdir "` + dir + `"`
	if line != want {
		t.Fatalf("command line\n got %s\nwant %s", line, want)
	}
	for _, bad := range []string{`C:\100%\x.exe`, `C:\a"b\x.exe`, "C:\\a\nb"} {
		if _, ok := WindowsSelfDeleteArgs([]string{bad}, ""); ok {
			t.Errorf("%q must be refused", bad)
		}
	}
	if !strings.Contains(WindowsCmdLine("cmd.exe", []string{"del", `C:\x y\z`}), `"C:\x y\z"`) {
		t.Error("paths must be quoted")
	}
}

func TestProfileDir(t *testing.T) {
	w := newWorld(t)
	profile := filepath.Join(w.home, ".config", "MossStudio")
	mustT(t, os.MkdirAll(filepath.Join(profile, "Cache"), 0o755))
	mustT(t, os.WriteFile(filepath.Join(profile, "Cookies"), []byte("x"), 0o644))
	c := w.checker()
	c.Profile = profile

	p := w.plan(true)
	p.ProfileDir = profile
	mustT(t, c.Validate(p))
	r, _ := runner(func() []proc.Info { return nil })
	mustT(t, r.Execute(p))
	if _, err := os.Stat(profile); !os.IsNotExist(err) {
		t.Fatal("profile folder should be deleted")
	}

	refuse := map[string]func(p *Plan, c *Checker){
		"data kept":       func(p *Plan, c *Checker) { rd := false; p.RemoveData = &rd; p.Remove = p.Remove[:len(p.Remove)-1] },
		"not the profile": func(p *Plan, c *Checker) { p.ProfileDir = filepath.Join(w.home, "Documents", "MossStudio") },
		"wrong name":      func(p *Plan, c *Checker) { p.ProfileDir = filepath.Join(w.home, ".config"); c.Profile = p.ProfileDir },
		"relative":        func(p *Plan, c *Checker) { p.ProfileDir = "MossStudio" },
		"unknown profile": func(p *Plan, c *Checker) { c.Profile = "" },
		"profile holds root": func(p *Plan, c *Checker) {
			p.Root = filepath.Join(profile, "R")
			p.DataRoot = filepath.Join(p.Root, "data")
			p.Remove = []string{p.DataRoot}
			p.RemoveEmptyDirs = nil
		},
	}
	for name, mut := range refuse {
		p := w.plan(true)
		p.ProfileDir = profile
		cc := c
		mut(p, &cc)
		if err := cc.Validate(p); err == nil {
			t.Errorf("%s: plan should be refused", name)
		}
	}
	// profileDir inside root: build a world whose profile name sits under R.
	p = w.plan(true)
	inRoot := filepath.Join(w.root, "MossStudio")
	p.ProfileDir = inRoot
	cc := c
	cc.Profile = inRoot
	if err := cc.Validate(p); err == nil {
		t.Error("profileDir inside root must be refused")
	}
}
