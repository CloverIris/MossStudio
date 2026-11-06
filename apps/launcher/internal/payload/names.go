package payload

import (
	"fmt"
	"path"
	"regexp"
	"strings"
)

// appDirRe matches the one top-level app folder: app-<semver>.
var appDirRe = regexp.MustCompile(`^app-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$`)

// AppDirVersion returns the version in an "app-<semver>" name, or "" if it is not one.
func AppDirVersion(name string) string {
	m := appDirRe.FindStringSubmatch(name)
	if m == nil {
		return ""
	}
	return m[1]
}

var reservedWin = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$`)

// CleanName validates a tar entry name and returns it cleaned (no trailing slash).
// It rejects absolute names, "..", backslashes, drive letters/ADS (":"), NUL, empty
// components, Windows device names and components ending in "." or " ".
func CleanName(name string) (string, error) {
	orig := name
	name = strings.TrimSuffix(name, "/")
	switch {
	case name == "" || name == ".":
		return "", fmt.Errorf("unsafe entry name %q: empty", orig)
	case strings.ContainsAny(name, "\\:\x00"):
		return "", fmt.Errorf("unsafe entry name %q: contains \\, : or NUL", orig)
	case strings.HasPrefix(name, "/"):
		return "", fmt.Errorf("unsafe entry name %q: absolute", orig)
	}
	for _, c := range strings.Split(name, "/") {
		switch {
		case c == "" || c == ".":
			return "", fmt.Errorf("unsafe entry name %q: empty or '.' component", orig)
		case c == "..":
			return "", fmt.Errorf("unsafe entry name %q: '..' component", orig)
		case strings.HasSuffix(c, ".") || strings.HasSuffix(c, " "):
			return "", fmt.Errorf("unsafe entry name %q: component ends with '.' or space", orig)
		case reservedWin.MatchString(c):
			return "", fmt.Errorf("unsafe entry name %q: reserved device name", orig)
		}
	}
	return name, nil
}

// CheckLinkTarget validates a symlink at entry name pointing to target: the target must be
// relative and, resolved from the link's directory, stay inside the archive root.
func CheckLinkTarget(name, target string) error {
	switch {
	case target == "":
		return fmt.Errorf("symlink %q: empty target", name)
	case strings.ContainsAny(target, "\\:\x00"):
		return fmt.Errorf("symlink %q: target %q contains \\, : or NUL", name, target)
	case strings.HasPrefix(target, "/"):
		return fmt.Errorf("symlink %q: absolute target %q", name, target)
	}
	resolved := path.Join(path.Dir(name), target)
	if resolved == ".." || strings.HasPrefix(resolved, "../") {
		return fmt.Errorf("symlink %q: target %q escapes the archive", name, target)
	}
	return nil
}
