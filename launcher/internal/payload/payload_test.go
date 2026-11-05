package payload

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeStub is an "ELF" launcher: enough for LauncherNameFor.
var fakeStub = append([]byte("\x7fELF"), bytes.Repeat([]byte{0xAB}, 4096)...)

func writeTree(t *testing.T, root string) {
	t.Helper()
	app := filepath.Join(root, "app-1.2.3-beta.1")
	must(t, os.MkdirAll(filepath.Join(app, "resources", "中文 目录"), 0o755))
	must(t, os.WriteFile(filepath.Join(app, "MossStudio"), []byte("#!/bin/sh\necho app\n"), 0o755))
	must(t, os.WriteFile(filepath.Join(app, "resources", "app.asar"), bytes.Repeat([]byte("asar"), 50_000), 0o644))
	must(t, os.WriteFile(filepath.Join(app, "resources", "中文 目录", "数据.txt"), []byte("你好"), 0o600))
	if runtime.GOOS != "windows" {
		must(t, os.Symlink("resources/app.asar", filepath.Join(app, "link-to-asar")))
		must(t, os.Symlink("中文 目录", filepath.Join(app, "resources", "dirlink")))
		must(t, os.Chmod(filepath.Join(app, "resources"), 0o750))
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func pack(t *testing.T) (string, PackResult) {
	t.Helper()
	dir := t.TempDir()
	src := filepath.Join(dir, "payload")
	must(t, os.Mkdir(src, 0o755))
	writeTree(t, src)
	stub := filepath.Join(dir, "stub")
	must(t, os.WriteFile(stub, fakeStub, 0o755))
	out := filepath.Join(dir, "MossStudio-Setup.run")
	res, err := Pack(PackOptions{Stub: stub, PayloadDir: src, Out: out, Level: gzip.BestSpeed})
	must(t, err)
	return out, res
}

func TestPackExtractRoundTrip(t *testing.T) {
	out, res := pack(t)
	if res.Version != "1.2.3-beta.1" || res.LauncherName != LauncherNameLinux {
		t.Fatalf("pack result %+v", res)
	}
	data, _ := os.ReadFile(out)
	if !bytes.HasPrefix(data, fakeStub) {
		t.Fatal("setup file must start with the stub")
	}
	f, tr, err := Open(out)
	must(t, err)
	defer f.Close()
	if tr.Offset != int64(len(fakeStub)) || tr.Size+int64(len(fakeStub))+TrailerSize != int64(len(data)) {
		t.Fatalf("trailer %+v", tr)
	}
	dest := t.TempDir()
	var last, total int64
	x, err := ExtractFile(f, tr, dest, LauncherNameLinux, func(d, tt int64) { last, total = d, tt })
	must(t, err)
	if last != total || total != 2*tr.Size {
		t.Errorf("progress ended at %d/%d", last, total)
	}
	if x.Version != "1.2.3-beta.1" || x.AppDir != filepath.Join(dest, "app-1.2.3-beta.1") {
		t.Fatalf("extracted %+v", x)
	}
	launcher, _ := os.ReadFile(x.LauncherPath)
	if !bytes.Equal(launcher, fakeStub) {
		t.Fatal("launcher copy differs from the stub")
	}
	if HasPayload(x.LauncherPath) {
		t.Fatal("launcher copy must not carry a payload")
	}
	got, _ := os.ReadFile(filepath.Join(x.AppDir, "resources", "中文 目录", "数据.txt"))
	if string(got) != "你好" {
		t.Fatalf("content %q", got)
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(filepath.Join(x.AppDir, "MossStudio"))
		if st.Mode().Perm() != 0o755 {
			t.Errorf("exec mode lost: %v", st.Mode())
		}
		st, _ = os.Stat(filepath.Join(x.AppDir, "resources", "中文 目录", "数据.txt"))
		if st.Mode().Perm() != 0o600 {
			t.Errorf("file mode lost: %v", st.Mode())
		}
		st, _ = os.Stat(filepath.Join(x.AppDir, "resources"))
		if st.Mode().Perm() != 0o750 {
			t.Errorf("dir mode lost: %v", st.Mode())
		}
		target, err := os.Readlink(filepath.Join(x.AppDir, "link-to-asar"))
		if err != nil || target != "resources/app.asar" {
			t.Errorf("symlink lost: %q %v", target, err)
		}
		if _, err := os.Stat(filepath.Join(x.AppDir, "resources", "dirlink", "数据.txt")); err != nil {
			t.Errorf("dir symlink broken: %v", err)
		}
	}
}

func TestPackIsDeterministic(t *testing.T) {
	a, _ := pack(t)
	b, _ := pack(t)
	da, _ := os.ReadFile(a)
	db, _ := os.ReadFile(b)
	if !bytes.Equal(da, db) {
		t.Fatal("two packs of the same tree differ")
	}
}

func TestTamperDetection(t *testing.T) {
	out, _ := pack(t)
	orig, _ := os.ReadFile(out)
	payloadStart := len(fakeStub)
	cases := map[string]func([]byte) []byte{
		"payload byte flipped": func(b []byte) []byte { b[payloadStart+100] ^= 1; return b },
		"last payload byte":    func(b []byte) []byte { b[len(b)-TrailerSize-1] ^= 0x80; return b },
		"hash in trailer":      func(b []byte) []byte { b[len(b)-TrailerSize+20] ^= 1; return b },
	}
	for name, mutate := range cases {
		b := mutate(append([]byte(nil), orig...))
		p := filepath.Join(t.TempDir(), "setup")
		must(t, os.WriteFile(p, b, 0o644))
		f, tr, err := Open(p)
		must(t, err)
		dest := t.TempDir()
		_, err = ExtractFile(f, tr, dest, LauncherNameLinux, nil)
		f.Close()
		if !errors.Is(err, ErrTampered) {
			t.Errorf("%s: want ErrTampered, got %v", name, err)
		}
		if ents, _ := os.ReadDir(dest); len(ents) != 0 {
			t.Errorf("%s: wrote %d entries before verifying", name, len(ents))
		}
	}
	// Structural damage: truncation, appended bytes, bad version, bad offset.
	structural := map[string][]byte{
		"truncated":   orig[:len(orig)-10],
		"appended":    append(append([]byte(nil), orig...), 0),
		"plain stub":  fakeStub,
		"tiny":        []byte("MZ"),
		"bad version": func() []byte { b := append([]byte(nil), orig...); b[len(b)-TrailerSize+48] = 9; return b }(),
		"bad offset":  func() []byte { b := append([]byte(nil), orig...); b[len(b)-TrailerSize] ^= 1; return b }(),
	}
	for name, b := range structural {
		p := filepath.Join(t.TempDir(), "setup")
		must(t, os.WriteFile(p, b, 0o644))
		if _, _, err := Open(p); err == nil {
			t.Errorf("%s: Open should fail", name)
		}
	}
}

func TestPackRefusals(t *testing.T) {
	dir := t.TempDir()
	stub := filepath.Join(dir, "stub")
	must(t, os.WriteFile(stub, fakeStub, 0o755))
	// Two app dirs.
	two := filepath.Join(dir, "two")
	must(t, os.MkdirAll(filepath.Join(two, "app-1.0.0"), 0o755))
	must(t, os.MkdirAll(filepath.Join(two, "app-1.0.1"), 0o755))
	if _, err := Pack(PackOptions{Stub: stub, PayloadDir: two, Out: filepath.Join(dir, "o")}); err == nil {
		t.Error("two app dirs must be refused")
	}
	// Not semver.
	bad := filepath.Join(dir, "bad")
	must(t, os.MkdirAll(filepath.Join(bad, "app-1.0"), 0o755))
	if _, err := Pack(PackOptions{Stub: stub, PayloadDir: bad, Out: filepath.Join(dir, "o")}); err == nil {
		t.Error("non-semver app dir must be refused")
	}
	// Stub that already has a payload.
	out, _ := pack(t)
	ok := filepath.Join(dir, "ok")
	must(t, os.MkdirAll(filepath.Join(ok, "app-1.0.0"), 0o755))
	if _, err := Pack(PackOptions{Stub: out, PayloadDir: ok, Out: filepath.Join(dir, "o")}); err == nil {
		t.Error("stub with payload must be refused")
	}
	// Unknown executable format.
	must(t, os.WriteFile(stub, []byte("#!/bin/sh"), 0o755))
	if _, err := Pack(PackOptions{Stub: stub, PayloadDir: ok, Out: filepath.Join(dir, "o")}); err == nil {
		t.Error("non-PE/ELF stub must be refused")
	}
	if runtime.GOOS != "windows" {
		esc := filepath.Join(dir, "esc")
		must(t, os.MkdirAll(filepath.Join(esc, "app-1.0.0"), 0o755))
		must(t, os.WriteFile(stub, fakeStub, 0o755))
		must(t, os.Symlink("/etc/passwd", filepath.Join(esc, "app-1.0.0", "evil")))
		if _, err := Pack(PackOptions{Stub: stub, PayloadDir: esc, Out: filepath.Join(dir, "o")}); err == nil {
			t.Error("absolute symlink must be refused at pack time")
		}
	}
	// A staged launcher copy is fine when identical to the stub, refused otherwise.
	staged := filepath.Join(dir, "staged")
	must(t, os.MkdirAll(filepath.Join(staged, "app-1.0.0"), 0o755))
	must(t, os.WriteFile(stub, fakeStub, 0o755))
	must(t, os.WriteFile(filepath.Join(staged, LauncherNameLinux), fakeStub, 0o755))
	if _, err := Pack(PackOptions{Stub: stub, PayloadDir: staged, Out: filepath.Join(dir, "ok.run"), Level: gzip.BestSpeed}); err != nil {
		t.Errorf("identical staged launcher refused: %v", err)
	}
	must(t, os.WriteFile(filepath.Join(staged, LauncherNameLinux), []byte("\x7fELF other"), 0o755))
	if _, err := Pack(PackOptions{Stub: stub, PayloadDir: staged, Out: filepath.Join(dir, "o")}); err == nil {
		t.Error("different staged launcher must be refused")
	}
	if _, err := os.Stat(filepath.Join(dir, "o")); !errors.Is(err, fs.ErrNotExist) {
		t.Error("failed packs must not leave an output file")
	}
}

type ent struct {
	name, link string
	typ        byte
	body       string
}

func archive(t *testing.T, ents ...ent) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for _, e := range ents {
		h := &tar.Header{Name: e.name, Typeflag: e.typ, Linkname: e.link, Mode: 0o644, Size: int64(len(e.body)), Format: tar.FormatPAX}
		if e.typ != tar.TypeReg {
			h.Size = 0
		}
		must(t, tw.WriteHeader(h))
		if e.typ == tar.TypeReg {
			tw.Write([]byte(e.body))
		}
	}
	must(t, tw.Close())
	must(t, zw.Close())
	return buf.Bytes()
}

func base() []ent {
	return []ent{
		{name: "app-1.0.0/", typ: tar.TypeDir},
		{name: "app-1.0.0/MossStudio", typ: tar.TypeReg, body: "x"},
		{name: LauncherNameLinux, typ: tar.TypeReg, body: "l"},
	}
}

func TestExtractAcceptsBase(t *testing.T) {
	dest := t.TempDir()
	if _, err := Extract(bytes.NewReader(archive(t, base()...)), dest, ExtractOptions{LauncherName: LauncherNameLinux}); err != nil {
		t.Fatal(err)
	}
}

func TestExtractRejectsUnsafe(t *testing.T) {
	outside := t.TempDir()
	cases := map[string][]ent{
		"dotdot":           {{name: "app-1.0.0/../../evil", typ: tar.TypeReg, body: "x"}},
		"leading dotdot":   {{name: "../evil", typ: tar.TypeReg, body: "x"}},
		"absolute":         {{name: "/tmp/evil", typ: tar.TypeReg, body: "x"}},
		"absolute outside": {{name: filepath.ToSlash(filepath.Join(outside, "evil")), typ: tar.TypeReg, body: "x"}},
		"backslash":        {{name: "app-1.0.0\\..\\..\\evil", typ: tar.TypeReg, body: "x"}},
		"drive letter":     {{name: "C:evil", typ: tar.TypeReg, body: "x"}},
		"device name":      {{name: "app-1.0.0/NUL.txt", typ: tar.TypeReg, body: "x"}},
		"trailing dot":     {{name: "app-1.0.0/x.", typ: tar.TypeReg, body: "x"}},
		"empty component":  {{name: "app-1.0.0//x", typ: tar.TypeReg, body: "x"}},
		"abs symlink":      {{name: "app-1.0.0/l", typ: tar.TypeSymlink, link: "/etc"}},
		"escaping symlink": {{name: "app-1.0.0/l", typ: tar.TypeSymlink, link: "../../etc"}},
		"write through symlink": {
			{name: "app-1.0.0/l", typ: tar.TypeSymlink, link: "MossStudio"},
			{name: "app-1.0.0/l/x", typ: tar.TypeReg, body: "x"},
		},
		"chained escape": {
			{name: "app-1.0.0/sub/", typ: tar.TypeDir},
			{name: "app-1.0.0/sub/up", typ: tar.TypeSymlink, link: "../.."},
			{name: "app-1.0.0/sub/esc", typ: tar.TypeSymlink, link: "up/.."},
		},
		"dangling symlink": {{name: "app-1.0.0/l", typ: tar.TypeSymlink, link: "missing"}},
		"hardlink":         {{name: "app-1.0.0/h", typ: tar.TypeLink, link: "app-1.0.0/MossStudio"}},
		"fifo":             {{name: "app-1.0.0/f", typ: tar.TypeFifo}},
		"char device":      {{name: "app-1.0.0/c", typ: tar.TypeChar}},
		"duplicate file":   {{name: "app-1.0.0/MossStudio", typ: tar.TypeReg, body: "y"}},
		"file over dir":    {{name: "app-1.0.0", typ: tar.TypeReg, body: "y"}},
		"extra top level":  {{name: "README", typ: tar.TypeReg, body: "y"}},
		"second app dir":   {{name: "app-2.0.0/", typ: tar.TypeDir}},
	}
	for name, extra := range cases {
		dest := t.TempDir()
		ents := append(base(), extra...)
		_, err := Extract(bytes.NewReader(archive(t, ents...)), dest, ExtractOptions{LauncherName: LauncherNameLinux})
		if err == nil {
			t.Errorf("%s: expected rejection", name)
		} else {
			t.Logf("%s: %v", name, err)
		}
		if _, err := os.Lstat(filepath.Join(outside, "evil")); err == nil {
			t.Fatalf("%s: wrote outside the destination", name)
		}
	}
	// Missing pieces.
	for name, ents := range map[string][]ent{
		"no launcher": base()[:2],
		"no app dir":  base()[2:],
	} {
		if _, err := Extract(bytes.NewReader(archive(t, ents...)), t.TempDir(), ExtractOptions{LauncherName: LauncherNameLinux}); err == nil {
			t.Errorf("%s: expected rejection", name)
		}
	}
}

func TestExtractRefusesNonEmptyDest(t *testing.T) {
	dest := t.TempDir()
	must(t, os.WriteFile(filepath.Join(dest, "x"), nil, 0o644))
	_, err := Extract(bytes.NewReader(archive(t, base()...)), dest, ExtractOptions{LauncherName: LauncherNameLinux})
	if err == nil || !strings.Contains(err.Error(), "not empty") {
		t.Fatalf("got %v", err)
	}
}

func TestExtractRejectsCorruptGzip(t *testing.T) {
	a := archive(t, base()...)
	a[len(a)-6] ^= 0xff // CRC32 in the gzip trailer
	if _, err := Extract(bytes.NewReader(a), t.TempDir(), ExtractOptions{LauncherName: LauncherNameLinux}); err == nil {
		t.Fatal("corrupt gzip must fail")
	}
}

func TestCleanName(t *testing.T) {
	good := map[string]string{"a/b/": "a/b", "app-1.0.0/中文 名.txt": "app-1.0.0/中文 名.txt", "a": "a"}
	for in, want := range good {
		got, err := CleanName(in)
		if err != nil || got != want {
			t.Errorf("CleanName(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", ".", "./a", "a/./b", "a/../b", "..", "/a", "a\\b", "c:", "a\x00", "aux", "COM1.log", "a /b"} {
		if _, err := CleanName(bad); err == nil {
			t.Errorf("CleanName(%q) should fail", bad)
		}
	}
}

func TestAppDirVersion(t *testing.T) {
	if AppDirVersion("app-1.2.3") != "1.2.3" || AppDirVersion("app-1.2.3-rc.1") != "1.2.3-rc.1" {
		t.Fatal("valid names")
	}
	for _, bad := range []string{"app-1.2", "app-1.2.3.partial", "xapp-1.2.3", "app-"} {
		if AppDirVersion(bad) != "" {
			t.Errorf("%q should not parse", bad)
		}
	}
}
