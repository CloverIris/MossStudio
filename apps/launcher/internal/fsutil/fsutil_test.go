package fsutil

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInside(t *testing.T) {
	cases := []struct {
		root, p      string
		fold, in, st bool
	}{
		{"/a/b", "/a/b", false, true, false},
		{"/a/b", "/a/b/c", false, true, true},
		{"/a/b", "/a/bc", false, false, false},
		{"/a/b", "/a/b/../c", false, false, false},
		{"/a/b", "/a/B/c", false, false, false},
		{"/a/b", "/a/B/c", true, true, true},
		{"/a/b", "relative", false, false, false},
		{"/a/b", "/a/b/..x", false, true, true},
	}
	for _, c := range cases {
		if got := Inside(c.root, c.p, c.fold); got != c.in {
			t.Errorf("Inside(%q, %q, %v) = %v", c.root, c.p, c.fold, got)
		}
		if got := StrictlyInside(c.root, c.p, c.fold); got != c.st {
			t.Errorf("StrictlyInside(%q, %q, %v) = %v", c.root, c.p, c.fold, got)
		}
	}
}

func TestWriteFileAtomic(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "安装.json")
	for _, content := range []string{"one", "two"} {
		if err := WriteFileAtomic(p, []byte(content), 0o640); err != nil {
			t.Fatal(err)
		}
		if b, _ := os.ReadFile(p); string(b) != content {
			t.Fatalf("content %q", b)
		}
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 1 {
		t.Fatalf("temp files left: %v", ents)
	}
	if err := WriteFileAtomic(filepath.Join(dir, "missing", "x"), nil, 0o644); err == nil {
		t.Fatal("missing dir must fail")
	}
}
