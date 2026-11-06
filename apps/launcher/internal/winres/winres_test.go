package winres

import (
	"bytes"
	"debug/pe"
	"encoding/binary"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

func testICO(t *testing.T) []byte {
	t.Helper()
	ico, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "apps", "desktop", "src", "renderer", "public", "mossstudio-icon.ico"))
	if err != nil {
		t.Fatalf("app icon not found: %v", err)
	}
	return ico
}

var info = Info{Version: "1.2.3-beta.4", Company: "CloverIris", Product: "MossStudio", Description: "MossStudio", Copyright: "© CloverIris", FileName: "MossStudio.exe"}

type leaf struct {
	typ, id, lang uint32
	rva, size     uint32
}

// walk parses a resource directory. base is the RVA of the section start (0 for objects).
func walk(t *testing.T, sect []byte) []leaf {
	t.Helper()
	le := binary.LittleEndian
	var out []leaf
	var rec func(off uint32, depth int, path []uint32)
	rec = func(off uint32, depth int, path []uint32) {
		n := int(le.Uint16(sect[off+12:])) + int(le.Uint16(sect[off+14:]))
		for i := 0; i < n; i++ {
			e := off + 16 + uint32(8*i)
			id := le.Uint32(sect[e:])
			target := le.Uint32(sect[e+4:])
			p := append(append([]uint32(nil), path...), id)
			if target&0x80000000 != 0 {
				rec(target&0x7fffffff, depth+1, p)
				continue
			}
			if depth != 2 {
				t.Fatalf("data entry at depth %d", depth)
			}
			out = append(out, leaf{p[0], p[1], p[2], le.Uint32(sect[target:]), le.Uint32(sect[target+4:])})
		}
	}
	rec(0, 0, nil)
	return out
}

func TestObjectLayout(t *testing.T) {
	ico := testICO(t)
	obj, err := Build(ico, info)
	if err != nil {
		t.Fatal(err)
	}
	f, err := pe.NewFile(bytes.NewReader(obj))
	if err != nil {
		t.Fatal(err)
	}
	if f.Machine != pe.IMAGE_FILE_MACHINE_AMD64 || len(f.Sections) != 1 || f.Sections[0].Name != ".rsrc" {
		t.Fatalf("header %+v", f.FileHeader)
	}
	s := f.Sections[0]
	data, _ := s.Data()
	leaves := walk(t, data)
	count := map[uint32]int{}
	for _, l := range leaves {
		count[l.typ]++
		if l.lang != langID || l.rva+l.size > uint32(len(data)) {
			t.Fatalf("bad leaf %+v", l)
		}
	}
	nImages := int(binary.LittleEndian.Uint16(ico[4:]))
	if count[rtIcon] != nImages || count[rtGroupIcon] != 1 || count[rtVersion] != 1 || count[rtManifest] != 1 {
		t.Fatalf("resource counts %v", count)
	}
	if len(s.Relocs) != len(leaves) {
		t.Fatalf("%d relocs for %d leaves", len(s.Relocs), len(leaves))
	}
	for _, r := range s.Relocs {
		if r.Type != 3 || r.SymbolTableIndex != 0 {
			t.Fatalf("reloc %+v", r)
		}
	}
	if len(f.COFFSymbols) != 1 || f.COFFSymbols[0].StorageClass != 3 || f.COFFSymbols[0].SectionNumber != 1 {
		t.Fatalf("symbols %+v", f.COFFSymbols)
	}
	// The manifest says asInvoker; the version block carries the strings.
	for _, l := range leaves {
		blob := data[l.rva : l.rva+l.size]
		switch l.typ {
		case rtManifest:
			if !bytes.Contains(blob, []byte(`level="asInvoker"`)) {
				t.Error("manifest lacks asInvoker")
			}
		case rtVersion:
			if !bytes.Contains(blob, utf16le("1.2.3-beta.4")) || !bytes.Contains(blob, utf16le("CloverIris")) {
				t.Error("version strings missing")
			}
			if binary.LittleEndian.Uint16(blob) != uint16(len(blob)) {
				t.Errorf("VS_VERSIONINFO wLength %d != %d", binary.LittleEndian.Uint16(blob), len(blob))
			}
			// VS_FIXEDFILEINFO: signature, then FileVersionMS = 1.2, LS = 3.0.
			i := bytes.Index(blob, []byte{0xBD, 0x04, 0xEF, 0xFE})
			if i < 0 || binary.LittleEndian.Uint32(blob[i+8:]) != 1<<16|2 || binary.LittleEndian.Uint32(blob[i+12:]) != 3<<16 {
				t.Error("fixed file info wrong")
			}
		case rtGroupIcon:
			if binary.LittleEndian.Uint16(blob[4:]) != uint16(nImages) || len(blob) != 6+14*nImages {
				t.Error("group icon directory wrong")
			}
		}
	}
	// Deterministic.
	again, _ := Build(ico, info)
	if !bytes.Equal(obj, again) {
		t.Error("Build is not deterministic")
	}
}

func utf16le(s string) []byte {
	var b bytes.Buffer
	for _, c := range utf16.Encode([]rune(s)) {
		binary.Write(&b, binary.LittleEndian, c)
	}
	return b.Bytes()
}

func TestRejectsBadInput(t *testing.T) {
	if _, err := Build([]byte("not an icon"), info); err == nil {
		t.Error("bad ico accepted")
	}
	bad := info
	bad.Version = "1.2"
	if _, err := Build(testICO(t), bad); err == nil {
		t.Error("bad version accepted")
	}
	trunc := append([]byte(nil), testICO(t)[:40]...)
	if _, err := Build(trunc, info); err == nil {
		t.Error("truncated ico accepted")
	}
}

// TestLinksIntoExecutable links the object into a real Windows executable with the Go
// toolchain and checks the final resource tree: every data entry must point inside .rsrc
// at the original bytes, which only holds if the relocations were applied.
func TestLinksIntoExecutable(t *testing.T) {
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Fatalf("go toolchain not on PATH: %v", err)
	}
	dir := t.TempDir()
	obj, err := Build(testICO(t), info)
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module x\n\ngo 1.21\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\n\nfunc main() {}\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "rsrc_windows_amd64.syso"), obj, 0o644)
	cmd := exec.Command(goBin, "build", "-o", "x.exe", ".")
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GOOS=windows", "GOARCH=amd64", "CGO_ENABLED=0", "GOFLAGS=-mod=mod")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	f, err := pe.Open(filepath.Join(dir, "x.exe"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	s := f.Section(".rsrc")
	if s == nil {
		t.Fatal("no .rsrc in the executable")
	}
	oh := f.OptionalHeader.(*pe.OptionalHeader64)
	rd := oh.DataDirectory[pe.IMAGE_DIRECTORY_ENTRY_RESOURCE]
	if rd.VirtualAddress != s.VirtualAddress {
		t.Fatalf("resource directory %#x != section %#x", rd.VirtualAddress, s.VirtualAddress)
	}
	data, _ := s.Data()
	found := false
	for _, l := range walk(t, data) {
		off := l.rva - s.VirtualAddress
		if l.rva < s.VirtualAddress || off+l.size > uint32(len(data)) {
			t.Fatalf("leaf %+v points outside .rsrc", l)
		}
		if l.typ == rtManifest && strings.Contains(string(data[off:off+l.size]), "asInvoker") {
			found = true
		}
	}
	if !found {
		t.Fatal("manifest not found through the linked resource tree")
	}
}
