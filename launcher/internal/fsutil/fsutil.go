// Package fsutil holds the small file-system helpers shared by the launcher's modes.
package fsutil

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// WriteFileAtomic writes data to a temp file next to path, fsyncs it and renames it over
// path, so readers see either the old or the new content, never a partial file.
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			tmp.Close()
			os.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(tmpName, perm); err != nil {
			return err
		}
	}
	if err := renameRetry(tmpName, path); err != nil {
		return err
	}
	ok = true
	syncDir(dir)
	return nil
}

// renameRetry retries briefly on Windows, where a reader holding the target open without
// FILE_SHARE_DELETE (antivirus, the app) makes MoveFileEx fail for a moment.
func renameRetry(from, to string) error {
	var err error
	for i := 0; i < 20; i++ {
		if err = os.Rename(from, to); err == nil || runtime.GOOS != "windows" {
			return err
		}
		time.Sleep(50 * time.Millisecond)
	}
	return err
}

func syncDir(dir string) {
	if runtime.GOOS == "windows" {
		return
	}
	if d, err := os.Open(dir); err == nil {
		d.Sync()
		d.Close()
	}
}

// RandomSuffix returns 8 random hex characters.
func RandomSuffix() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%08x", time.Now().UnixNano()&0xffffffff)
	}
	return hex.EncodeToString(b[:])
}

// FoldCase reports whether paths compare case-insensitively on this OS.
var FoldCase = runtime.GOOS == "windows" || runtime.GOOS == "darwin"

// Inside reports whether p is root itself or below it, lexically, after cleaning both.
// Both must be absolute. Comparison folds case when fold is true.
func Inside(root, p string, fold bool) bool {
	rel, ok := relative(root, p, fold)
	return ok && rel != ".."
}

// StrictlyInside reports whether p is below root (not root itself).
func StrictlyInside(root, p string, fold bool) bool {
	rel, ok := relative(root, p, fold)
	return ok && rel != "." && rel != ".."
}

// relative returns the cleaned relative path, or ".." for any path outside root.
func relative(root, p string, fold bool) (string, bool) {
	if !filepath.IsAbs(root) || !filepath.IsAbs(p) {
		return "", false
	}
	root, p = filepath.Clean(root), filepath.Clean(p)
	if fold {
		root, p = strings.ToLower(root), strings.ToLower(p)
	}
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return "", false
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "..", true
	}
	return rel, true
}

// SamePath compares two absolute paths after cleaning, folding case when fold is true.
func SamePath(a, b string, fold bool) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if fold {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// IsDir reports whether path exists and is a directory (following symlinks).
func IsDir(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.IsDir()
}

// Exists reports whether path exists (without following a final symlink).
func Exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}
