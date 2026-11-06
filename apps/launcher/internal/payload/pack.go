package payload

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// Launcher file names inside the payload (and in the install root).
const (
	LauncherNameWindows = "MossStudio.exe"
	LauncherNameLinux   = "mossstudio"
)

// LauncherNameFor returns the payload's launcher file name for a stub binary, from its
// executable format (PE → Windows, ELF → Linux).
func LauncherNameFor(stub []byte) (string, error) {
	switch {
	case bytes.HasPrefix(stub, []byte("MZ")):
		return LauncherNameWindows, nil
	case bytes.HasPrefix(stub, []byte("\x7fELF")):
		return LauncherNameLinux, nil
	}
	return "", errors.New("stub is neither a Windows (PE) nor a Linux (ELF) executable")
}

// PackOptions configure Pack.
type PackOptions struct {
	// Stub is the payload-less launcher binary (also copied into the payload).
	Stub string
	// PayloadDir holds exactly one app-<version>/ directory and, optionally, the launcher
	// file (MossStudio.exe / mossstudio) when it is byte-identical to Stub.
	PayloadDir string
	// Out is the setup file to write (replaced atomically).
	Out string
	// Level is the gzip level; 0 means gzip.BestCompression.
	Level int
}

// PackResult describes a written setup file.
type PackResult struct {
	Version      string
	LauncherName string
	Trailer      Trailer
}

// Pack writes Out = Stub + gzip(tar(app-<v>/, launcher copy)) + trailer.
func Pack(o PackOptions) (PackResult, error) {
	var res PackResult
	stub, err := os.ReadFile(o.Stub)
	if err != nil {
		return res, err
	}
	if _, err := ReadTrailer(bytes.NewReader(stub), int64(len(stub))); !errors.Is(err, ErrNoPayload) {
		return res, errors.New("stub already carries a payload; pass the plain launcher binary")
	}
	// A signed stub: the payload keeps the signed copy (it becomes R\MossStudio.exe), the
	// setup file starts from the stub without its signature, to be signed as a whole.
	prefix, err := stripSignature(stub)
	if err != nil {
		return res, err
	}
	res.LauncherName, err = LauncherNameFor(stub)
	if err != nil {
		return res, err
	}
	all, err := os.ReadDir(o.PayloadDir)
	if err != nil {
		return res, err
	}
	// A launcher copy already staged in the payload dir is accepted when it is the stub itself.
	var entries []os.DirEntry
	for _, e := range all {
		if e.Name() == res.LauncherName && e.Type().IsRegular() {
			staged, err := os.ReadFile(filepath.Join(o.PayloadDir, e.Name()))
			if err != nil {
				return res, err
			}
			if !bytes.Equal(staged, stub) {
				return res, fmt.Errorf("%s in the payload dir differs from --stub", e.Name())
			}
			continue
		}
		entries = append(entries, e)
	}
	if len(entries) != 1 || !entries[0].IsDir() || AppDirVersion(entries[0].Name()) == "" {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		return res, fmt.Errorf("payload dir must hold exactly one app-<version>/ directory (and optionally the launcher, identical to --stub), found %v", names)
	}
	appName := entries[0].Name()
	res.Version = AppDirVersion(appName)
	level := o.Level
	if level == 0 {
		level = gzip.BestCompression
	}

	tmp, err := os.CreateTemp(filepath.Dir(o.Out), "."+filepath.Base(o.Out)+".tmp-*")
	if err != nil {
		return res, err
	}
	ok := false
	defer func() {
		if !ok {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	bw := bufio.NewWriterSize(tmp, 1<<20)
	if _, err := bw.Write(prefix); err != nil {
		return res, err
	}
	h := sha256.New()
	cw := &countWriter{w: io.MultiWriter(bw, h)}
	zw, err := gzip.NewWriterLevel(cw, level)
	if err != nil {
		return res, err
	}
	tw := tar.NewWriter(zw)
	if err := addTree(tw, o.PayloadDir, appName); err != nil {
		return res, err
	}
	if err := writeFileEntry(tw, res.LauncherName, 0o755, bytes.NewReader(stub), int64(len(stub))); err != nil {
		return res, err
	}
	if err := tw.Close(); err != nil {
		return res, err
	}
	if err := zw.Close(); err != nil {
		return res, err
	}
	// Zero padding inside the payload makes the file length a multiple of 8, the alignment
	// Authenticode wants before the certificate table.
	if pad := (8 - (int64(len(prefix))+cw.n+TrailerSize)%8) % 8; pad > 0 {
		if _, err := cw.Write(make([]byte, pad)); err != nil {
			return res, err
		}
	}
	res.Trailer = Trailer{Offset: int64(len(prefix)), Size: cw.n, Version: FormatVersion}
	copy(res.Trailer.SHA256[:], h.Sum(nil))
	if _, err := bw.Write(res.Trailer.Encode()); err != nil {
		return res, err
	}
	if err := bw.Flush(); err != nil {
		return res, err
	}
	if !isWindowsHost() {
		if err := tmp.Chmod(0o755); err != nil {
			return res, err
		}
	}
	if err := tmp.Close(); err != nil {
		return res, err
	}
	if err := os.Rename(tmp.Name(), o.Out); err != nil {
		return res, err
	}
	ok = true
	return res, nil
}

var zeroTime = time.Unix(0, 0)

// addTree adds dir/name and everything below it, in sorted order.
func addTree(tw *tar.Writer, base, top string) error {
	var paths []string
	err := filepath.WalkDir(filepath.Join(base, top), func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		paths = append(paths, p)
		return nil
	})
	if err != nil {
		return err
	}
	sort.Strings(paths)
	for _, p := range paths {
		rel, err := filepath.Rel(base, p)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(rel)
		if _, err := CleanName(name); err != nil {
			return err
		}
		st, err := os.Lstat(p)
		if err != nil {
			return err
		}
		mode := st.Mode()
		switch {
		case mode.IsDir():
			perm := int64(mode.Perm())
			if isWindowsHost() {
				perm = 0o755
			}
			hdr := &tar.Header{Typeflag: tar.TypeDir, Name: name + "/", Mode: perm, ModTime: zeroTime, Format: tar.FormatPAX}
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
		case mode&fs.ModeSymlink != 0:
			target, err := os.Readlink(p)
			if err != nil {
				return err
			}
			target = filepath.ToSlash(target)
			if err := CheckLinkTarget(name, target); err != nil {
				return err
			}
			hdr := &tar.Header{Typeflag: tar.TypeSymlink, Name: name, Linkname: target, Mode: 0o777, ModTime: zeroTime, Format: tar.FormatPAX}
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
		case mode.IsRegular():
			perm := mode.Perm()
			if isWindowsHost() {
				perm = 0o644
				if strings.EqualFold(filepath.Ext(p), ".exe") {
					perm = 0o755
				}
			}
			f, err := os.Open(p)
			if err != nil {
				return err
			}
			err = writeFileEntry(tw, name, perm, f, st.Size())
			f.Close()
			if err != nil {
				return err
			}
		default:
			return fmt.Errorf("%s: unsupported file type %v", p, mode.Type())
		}
	}
	return nil
}

func writeFileEntry(tw *tar.Writer, name string, perm fs.FileMode, r io.Reader, size int64) error {
	hdr := &tar.Header{Typeflag: tar.TypeReg, Name: name, Mode: int64(perm), Size: size, ModTime: zeroTime, Format: tar.FormatPAX}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	n, err := io.Copy(tw, r)
	if err != nil {
		return err
	}
	if n != size {
		return fmt.Errorf("%s changed while packing", name)
	}
	return nil
}

type countWriter struct {
	w io.Writer
	n int64
}

func (c *countWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

func isWindowsHost() bool { return runtime.GOOS == "windows" }
