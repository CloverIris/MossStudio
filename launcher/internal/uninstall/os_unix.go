//go:build !windows

package uninstall

import (
	"errors"
	"os"
	"path/filepath"
)

// ProfileDir is Electron's userData folder for MossStudio on Linux:
// ${XDG_CONFIG_HOME:-$HOME/.config}/MossStudio (XDG_CONFIG_HOME only when absolute).
// "" when neither can be determined.
func ProfileDir() string {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" && filepath.IsAbs(x) {
		return filepath.Join(x, "MossStudio")
	}
	if home, err := os.UserHomeDir(); err == nil && filepath.IsAbs(home) {
		return filepath.Join(home, ".config", "MossStudio")
	}
	return ""
}

func longPath(p string) string { return p }

func xdgDir(name string, home string, fallback ...string) string {
	if v := os.Getenv(name); v != "" && filepath.IsAbs(v) {
		return v
	}
	if home == "" {
		return ""
	}
	return filepath.Join(append([]string{home}, fallback...)...)
}

// DefaultLocations are the Linux integration files, as integration.ts/layout.ts create them:
// ${XDG_DATA_HOME:-~/.local/share}/applications/mossstudio.desktop, its
// icons/hicolor/512x512/apps/mossstudio.png, and ${XDG_CONFIG_HOME:-~/.config}/MossStudio/locator.json.
func DefaultLocations(home string) Locations {
	var l Locations
	if data := xdgDir("XDG_DATA_HOME", home, ".local", "share"); data != "" {
		l.Integration = append(l.Integration,
			filepath.Join(data, "applications", "mossstudio.desktop"),
			filepath.Join(data, "icons", "hicolor", "512x512", "apps", "mossstudio.png"))
	}
	if cfg := xdgDir("XDG_CONFIG_HOME", home, ".config"); cfg != "" {
		l.LocatorDir = filepath.Join(cfg, "MossStudio")
		l.Integration = append(l.Integration, filepath.Join(l.LocatorDir, "locator.json"))
	}
	return l
}

// DeleteRegistryKey is a no-op outside Windows.
func DeleteRegistryKey(key string) error { return nil }

// DeleteSelf unlinks files (a running executable can be unlinked) and then the folder dir
// if it is empty.
func DeleteSelf(files []string, dir string) error {
	var errs []error
	for _, f := range files {
		if err := os.Remove(f); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	if dir != "" {
		os.Remove(dir)
	}
	return errors.Join(errs...)
}
