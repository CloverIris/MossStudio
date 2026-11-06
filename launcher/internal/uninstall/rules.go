package uninstall

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/CloverIris/MossStudio/launcher/internal/fsutil"
	"github.com/CloverIris/MossStudio/launcher/internal/payload"
	"github.com/CloverIris/MossStudio/launcher/internal/record"
)

// Locations are the per-user places outside R and the data root that an install creates.
// The launcher computes them itself (DefaultLocations); a plan may only touch these.
type Locations struct {
	// Integration lists the exact shortcut, .desktop, icon and locator files.
	Integration []string
	// LocatorDir is the locator's folder (removeEmptyDirs may name it).
	LocatorDir string
}

// DefaultChecker is the checker main uses: this user's home, profile and integration
// locations, case folding on Windows.
func DefaultChecker(launcher string) Checker {
	home, _ := os.UserHomeDir()
	return Checker{Home: home, Fold: fsutil.FoldCase, Launcher: launcher, Profile: ProfileDir(), Locations: DefaultLocations(home)}
}

// systemFolders mirrors locationRule's systemFolders in apps/desktop/src/main/install/location.ts:
// R and the data root may be neither inside a `within` folder nor equal to an `exact` one.
func systemFolders(platform, home string, getenv func(string) string) (within, exact []string) {
	env := func(names ...string) []string {
		var out []string
		for _, n := range names {
			if v := strings.TrimSpace(getenv(n)); v != "" {
				out = append(out, v)
			}
		}
		return out
	}
	if platform == "win32-x64" {
		windows := env("SystemRoot", "windir")
		drive := "C:"
		if len(windows) > 0 && len(windows[0]) >= 2 {
			drive = windows[0][:2]
		}
		within = append(windows, env("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData")...)
		within = append(within, drive+`\Windows`, drive+`\Program Files`, drive+`\Program Files (x86)`,
			drive+`\ProgramData`, drive+`\$Recycle.Bin`, drive+`\System Volume Information`)
		exact = []string{drive + `\Users`}
		if home != "" {
			exact = append(exact, home,
				filepath.Join(home, "AppData"), filepath.Join(home, "AppData", "Local"),
				filepath.Join(home, "AppData", "Roaming"), filepath.Join(home, "AppData", "Local", "Programs"),
				filepath.Join(home, "Desktop"), filepath.Join(home, "Documents"), filepath.Join(home, "Downloads"))
		}
		exact = append(exact, env("LOCALAPPDATA", "APPDATA", "USERPROFILE", "PUBLIC")...)
		return within, exact
	}
	within = []string{"/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/run",
		"/sbin", "/sys", "/usr", "/var", "/snap", "/lost+found"}
	exact = []string{"/home", "/opt", "/mnt", "/media", "/srv", "/root"}
	if home != "" {
		exact = append(exact, home, filepath.Join(home, ".local"), filepath.Join(home, ".local", "share"),
			filepath.Join(home, ".config"), filepath.Join(home, "Desktop"), filepath.Join(home, "Documents"),
			filepath.Join(home, "Downloads"))
	}
	return within, exact
}

// systemFolderProblem names the system folder dir is or lies in, or "".
func (c Checker) systemFolderProblem(dir string) string {
	getenv := c.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	within, exact := systemFolders(c.platform(), c.Home, getenv)
	for _, f := range within {
		if filepath.IsAbs(f) && fsutil.Inside(f, dir, c.Fold) {
			return f
		}
	}
	for _, f := range exact {
		if filepath.IsAbs(f) && fsutil.SamePath(f, dir, c.Fold) {
			return f
		}
	}
	return ""
}

var (
	// app-<v> and its work folders, as ownedRootEntries in uninstall.ts: .partial (Setup),
	// .partial.delta, .update-partial and .update-partial.delta (updater), .replaced-<id>.
	ownedAppRe    = regexp.MustCompile(`^app-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\.partial|\.partial\.delta|\.update-partial|\.update-partial\.delta|\.replaced-[0-9a-z]+)?$`)
	ownedLegacyRe = regexp.MustCompile(`^\.moss-legacy-[0-9a-z]+$`)
)

// updatesDir is the updater's staging folder in R (downloads, feed cache).
const updatesDir = ".updates"

// launcherFileName is the launcher's name in R for a plan platform.
func launcherFileName(platform string) string {
	if platform == "win32-x64" {
		return "MossStudio.exe"
	}
	return "mossstudio"
}

// ownedRootName mirrors ownedRootEntries in apps/desktop/src/main/install/uninstall.ts: the
// names in R the install owns (app folders and their leftovers, the updater's .updates
// staging, the launcher and its leftovers, install.json, portable.json, cleanup trash).
func ownedRootName(platform, name string, fold bool) bool {
	n := name
	if fold {
		n = strings.ToLower(name)
	}
	launcher := launcherFileName(platform)
	if fold {
		launcher = strings.ToLower(launcher)
	}
	switch {
	case ownedAppRe.MatchString(n), ownedLegacyRe.MatchString(n), strings.HasPrefix(n, ".moss-trash-"):
		return true
	case n == record.FileName, n == "portable.json", n == updatesDir:
		return true
	case n == launcher, strings.HasPrefix(n, launcher+".old-"), strings.HasPrefix(n, "."+launcher+".new-"):
		return true
	}
	return false
}

// installEvidence checks that plan.root really is the install the plan says: an install.json
// that parses with the same root and dataRoot; or a portable.json that parses with dataRoot
// R/data; or, when install.json is missing or unreadable, the launcher plus an app-<v>
// folder in R with dataRoot R/data (so a deleted or damaged record can still be uninstalled).
func (c Checker) installEvidence(p *Plan) string {
	rec, err := record.Read(record.Path(p.Root))
	if err == nil {
		if fsutil.SamePath(rec.Root, p.Root, c.Fold) && fsutil.SamePath(rec.DataRoot, p.DataRoot, c.Fold) {
			return ""
		}
		return "install.json in root names root " + rec.Root + " and dataRoot " + rec.DataRoot
	}
	defaultData := fsutil.SamePath(filepath.Join(p.Root, "data"), p.DataRoot, c.Fold)
	if data, rerr := os.ReadFile(filepath.Join(p.Root, "portable.json")); rerr == nil {
		var m struct {
			Schema  int    `json:"schema"`
			Version string `json:"version"`
		}
		if json.Unmarshal(data, &m) == nil && m.Schema == 1 && record.IsSemver(m.Version) {
			if defaultData {
				return ""
			}
			return "portable root with a dataRoot other than root/data"
		}
	}
	if defaultData && fsutil.Exists(filepath.Join(p.Root, launcherFileName(c.platform()))) {
		ents, _ := os.ReadDir(p.Root)
		for _, e := range ents {
			if e.IsDir() && payload.AppDirVersion(e.Name()) != "" {
				return ""
			}
		}
	}
	return "root holds no install.json or portable.json that matches the plan"
}

// dataMarkers name what a MossStudio data root holds (location.ts looksLikeData).
var dataMarkers = []string{"settings.json", "instances", "models"}

// dataProblem checks that a data root about to be deleted is MossStudio's: it holds a
// marker, or is missing, or holds nothing but the launcher's logs.
func dataProblem(dataRoot string) string {
	ents, err := os.ReadDir(dataRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return ""
		}
		return err.Error()
	}
	for _, m := range dataMarkers {
		if fsutil.Exists(filepath.Join(dataRoot, m)) {
			return ""
		}
	}
	for _, e := range ents {
		if e.Name() != "logs" {
			return "it holds no settings.json, instances or models, so it does not look like MossStudio data"
		}
	}
	return ""
}

func (c Checker) isIntegrationFile(path string) bool {
	for _, f := range c.Locations.Integration {
		if filepath.IsAbs(f) && fsutil.SamePath(f, path, c.Fold) {
			return true
		}
	}
	return false
}
