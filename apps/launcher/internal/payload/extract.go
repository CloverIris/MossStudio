package payload

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/CloverIris/MossStudio/apps/launcher/internal/fsutil"
)

// Extracted describes a successfully extracted payload.
type Extracted struct {
	Dir          string // the extraction root (the payloadDir passed to the app)
	Version      string
	AppDir       string // Dir/app-<version>
	LauncherPath string // Dir/<launcher name>
}

// ExtractOptions configure Extract.
type ExtractOptions struct {
	// LauncherName is the launcher entry expected at the top level.
	LauncherName string
	// Progress, if set, is called with the number of compressed bytes consumed.
	Progress func(done int64)
}

// ExtractFile verifies the payload of the setup file f (described by t) and extracts it
// into dest, which must be an existing empty directory. Verification reads the payload once
// before anything is written. progress reports (bytes done, total) across both passes:
// the hash pass counts the first t.Size bytes, extraction the second t.Size.
func ExtractFile(f io.ReaderAt, t Trailer, dest, launcherName string, progress func(done, total int64)) (*Extracted, error) {
	total := 2 * t.Size
	report := func(base int64) func(int64) {
		if progress == nil {
			return nil
		}
		return func(n int64) { progress(base+n, total) }
	}
	if err := Verify(f, t, report(0)); err != nil {
		return nil, err
	}
	x, err := Extract(io.NewSectionReader(f, t.Offset, t.Size), dest, ExtractOptions{LauncherName: launcherName, Progress: report(t.Size)})
	if err == nil && progress != nil {
		progress(total, total)
	}
	return x, err
}

// Extract unpacks a gzip-compressed tar into dest (an existing, empty directory) without
// ever writing outside it: names are validated (CleanName), no entry is written through a
// symlink or a file, duplicates are refused, symlink targets must stay inside dest (checked
// lexically when written and again by real resolution afterwards), and only directories,
// regular files and symlinks are accepted. On Linux, permission bits are applied (setuid,
// setgid and sticky bits are dropped; directories keep owner rwx). The top level must be exactly app-<version>/ and the
// launcher file.
func Extract(r io.Reader, dest string, o ExtractOptions) (*Extracted, error) {
	dest, err := filepath.Abs(dest)
	if err != nil {
		return nil, err
	}
	if ents, err := os.ReadDir(dest); err != nil {
		return nil, err
	} else if len(ents) != 0 {
		return nil, fmt.Errorf("extraction dir %s is not empty", dest)
	}
	cr := &countingReader{r: r, fn: o.Progress}
	zr, err := gzip.NewReader(cr)
	if err != nil {
		return nil, fmt.Errorf("payload is not gzip: %w", err)
	}
	zr.Multistream(false)
	tr := tar.NewReader(zr)

	x := &extractor{dest: dest, kinds: map[string]byte{}, dirModes: map[string]fs.FileMode{}}
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read payload archive: %w", err)
		}
		if err := x.entry(hdr, tr); err != nil {
			return nil, err
		}
	}
	// Drain the gzip trailer so its checksum is verified too.
	if _, err := io.Copy(io.Discard, zr); err != nil {
		return nil, fmt.Errorf("payload archive: %w", err)
	}
	if err := x.checkLinks(); err != nil {
		return nil, err
	}
	if err := x.applyDirModes(); err != nil {
		return nil, err
	}
	return x.result(o.LauncherName)
}

type extractor struct {
	dest     string
	kinds    map[string]byte // cleaned name → 'd', 'f' or 'l'
	links    []string
	dirModes map[string]fs.FileMode
}

func (x *extractor) full(name string) string { return filepath.Join(x.dest, filepath.FromSlash(name)) }

// ensureParents creates the missing ancestors of name as real directories and refuses to
// go through anything that is not a directory this extraction created.
func (x *extractor) ensureParents(name string) error {
	parts := strings.Split(name, "/")
	for i := 1; i < len(parts); i++ {
		anc := strings.Join(parts[:i], "/")
		switch x.kinds[anc] {
		case 'd':
			continue
		case 'f', 'l':
			return fmt.Errorf("unsafe entry %q: parent %q is not a directory", name, anc)
		}
		if err := os.Mkdir(x.full(anc), 0o755); err != nil {
			return err
		}
		x.kinds[anc] = 'd'
	}
	return nil
}

func (x *extractor) entry(hdr *tar.Header, r io.Reader) error {
	if hdr.Typeflag == tar.TypeXGlobalHeader {
		return nil
	}
	name, err := CleanName(hdr.Name)
	if err != nil {
		return err
	}
	if path.Clean(name) != name {
		return fmt.Errorf("unsafe entry name %q: not clean", hdr.Name)
	}
	if err := x.ensureParents(name); err != nil {
		return err
	}
	prev, exists := x.kinds[name]
	perm := fs.FileMode(hdr.Mode).Perm()
	switch hdr.Typeflag {
	case tar.TypeDir:
		if exists && prev != 'd' {
			return fmt.Errorf("duplicate entry %q", name)
		}
		if !exists {
			if err := os.Mkdir(x.full(name), 0o755); err != nil {
				return err
			}
			x.kinds[name] = 'd'
		}
		// The owner always keeps rwx so the tree can be filled and later removed.
		x.dirModes[name] = perm | 0o700
	case tar.TypeReg, tar.TypeRegA:
		if exists {
			return fmt.Errorf("duplicate entry %q", name)
		}
		x.kinds[name] = 'f'
		f, err := os.OpenFile(x.full(name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		n, err := io.Copy(f, r)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return fmt.Errorf("extract %s: %w", name, err)
		}
		if n != hdr.Size {
			return fmt.Errorf("extract %s: short file", name)
		}
		if runtime.GOOS != "windows" {
			if err := os.Chmod(x.full(name), perm); err != nil {
				return err
			}
		}
	case tar.TypeSymlink:
		if exists {
			return fmt.Errorf("duplicate entry %q", name)
		}
		if err := CheckLinkTarget(name, hdr.Linkname); err != nil {
			return err
		}
		x.kinds[name] = 'l'
		if err := os.Symlink(filepath.FromSlash(hdr.Linkname), x.full(name)); err != nil {
			return fmt.Errorf("create symlink %s: %w", name, err)
		}
		x.links = append(x.links, name)
	default:
		return fmt.Errorf("entry %q: unsupported type %q (only directories, files and symlinks)", name, string(hdr.Typeflag))
	}
	return nil
}

// checkLinks resolves every symlink for real; one that resolves outside dest, or does not
// resolve at all, fails the extraction (a chain of individually-relative links can escape).
func (x *extractor) checkLinks() error {
	realDest, err := filepath.EvalSymlinks(x.dest)
	if err != nil {
		return err
	}
	for _, name := range x.links {
		resolved, err := filepath.EvalSymlinks(x.full(name))
		if err != nil {
			// Dangling links are refused too: where they point cannot be checked, and a
			// later write through one could land outside the payload.
			return fmt.Errorf("symlink %s does not resolve: %w", name, err)
		}
		if !fsutil.Inside(realDest, resolved, fsutil.FoldCase) {
			return fmt.Errorf("symlink %s resolves outside the payload (%s)", name, resolved)
		}
	}
	return nil
}

// applyDirModes sets directory permissions deepest first, after all files are written.
func (x *extractor) applyDirModes() error {
	if runtime.GOOS == "windows" {
		return nil
	}
	names := make([]string, 0, len(x.dirModes))
	for n := range x.dirModes {
		names = append(names, n)
	}
	sort.Slice(names, func(i, j int) bool { return strings.Count(names[i], "/") > strings.Count(names[j], "/") })
	for _, n := range names {
		if err := os.Chmod(x.full(n), x.dirModes[n]); err != nil {
			return err
		}
	}
	return nil
}

func (x *extractor) result(launcherName string) (*Extracted, error) {
	res := &Extracted{Dir: x.dest}
	var other []string
	for name, kind := range x.kinds {
		if strings.Contains(name, "/") {
			continue
		}
		switch {
		case kind == 'd' && AppDirVersion(name) != "" && res.Version == "":
			res.Version = AppDirVersion(name)
			res.AppDir = x.full(name)
		case kind == 'f' && name == launcherName:
			res.LauncherPath = x.full(name)
		default:
			other = append(other, name)
		}
	}
	sort.Strings(other)
	switch {
	case len(other) > 0:
		return nil, fmt.Errorf("payload has unexpected top-level entries %v", other)
	case res.AppDir == "":
		return nil, errors.New("payload has no app-<version>/ directory")
	case launcherName != "" && res.LauncherPath == "":
		return nil, fmt.Errorf("payload has no %s launcher", launcherName)
	}
	return res, nil
}
