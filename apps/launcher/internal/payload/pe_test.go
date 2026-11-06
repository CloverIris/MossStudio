package payload

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

const (
	peLfanew   = 0x80
	peOptional = peLfanew + 24
	peSecEntry = peOptional + 112 + 4*8 // PE32+ data directory 4
)

// fakePE is a minimal PE32+ header (enough for securityDir) followed by filler.
func fakePE() []byte {
	b := make([]byte, 0x400)
	copy(b, "MZ")
	binary.LittleEndian.PutUint32(b[0x3c:], peLfanew)
	copy(b[peLfanew:], "PE\x00\x00")
	binary.LittleEndian.PutUint16(b[peLfanew+4:], 0x8664)
	binary.LittleEndian.PutUint16(b[peLfanew+4+16:], 240) // SizeOfOptionalHeader
	binary.LittleEndian.PutUint16(b[peOptional:], 0x20b)
	binary.LittleEndian.PutUint32(b[peOptional+108:], 16) // NumberOfRvaAndSizes
	for i := 0x300; i < len(b); i++ {
		b[i] = 0xCC
	}
	return b
}

// sign appends a fake certificate table (after pad zero bytes) and points the security
// directory at it, as signtool/osslsigncode do.
func sign(b []byte, pad int) []byte {
	out := append(append([]byte(nil), b...), make([]byte, pad)...)
	cert := bytes.Repeat([]byte{0x30, 0x82}, 600) // 1200 bytes, a multiple of 8
	binary.LittleEndian.PutUint32(out[peSecEntry:], uint32(len(out)))
	binary.LittleEndian.PutUint32(out[peSecEntry+4:], uint32(len(cert)))
	return append(out, cert...)
}

func packPE(t *testing.T, stub []byte) (string, []byte) {
	t.Helper()
	dir := t.TempDir()
	src := filepath.Join(dir, "payload")
	must(t, os.MkdirAll(filepath.Join(src, "app-2.0.0"), 0o755))
	must(t, os.WriteFile(filepath.Join(src, "app-2.0.0", "MossStudio.exe"), []byte("app"), 0o755))
	stubPath := filepath.Join(dir, "stub.exe")
	must(t, os.WriteFile(stubPath, stub, 0o755))
	out := filepath.Join(dir, "MossStudio-Setup-2.0.0-x64.exe")
	if _, err := Pack(PackOptions{Stub: stubPath, PayloadDir: src, Out: out, Level: gzip.BestSpeed}); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(out)
	return out, data
}

func extractOK(t *testing.T, path string) *Extracted {
	t.Helper()
	f, tr, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()
	x, err := ExtractFile(f, tr, t.TempDir(), LauncherNameWindows, nil)
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	return x
}

func TestSignedSetupFileIsFound(t *testing.T) {
	out, data := packPE(t, fakePE())
	if len(data)%8 != 0 {
		t.Fatalf("setup length %d is not 8-aligned", len(data))
	}
	extractOK(t, out)
	for _, pad := range []int{0, 3, 7} {
		signed := filepath.Join(t.TempDir(), "signed.exe")
		must(t, os.WriteFile(signed, sign(data, pad), 0o644))
		if x := extractOK(t, signed); x.Version != "2.0.0" {
			t.Fatalf("pad %d: version %q", pad, x.Version)
		}
	}
	// Non-zero bytes between the trailer and the certificate table: not a setup file.
	bad := sign(data, 0)
	bad = append(append(append([]byte(nil), bad[:len(data)]...), 1), bad[len(data):]...)
	binary.LittleEndian.PutUint32(bad[peSecEntry:], uint32(len(data)+1))
	p := filepath.Join(t.TempDir(), "bad.exe")
	must(t, os.WriteFile(p, bad, 0o644))
	if _, _, err := Open(p); err == nil {
		t.Error("a non-zero gap must not be accepted")
	}
	// A security directory pointing past the end of the file.
	broken := sign(data, 0)
	binary.LittleEndian.PutUint32(broken[peSecEntry+4:], 1<<30)
	must(t, os.WriteFile(p, broken, 0o644))
	if _, _, err := Open(p); err == nil || errors.Is(err, ErrNoPayload) {
		t.Errorf("broken signature table: %v", err)
	}
	// A signed plain launcher (no payload) is still a plain launcher.
	must(t, os.WriteFile(p, sign(fakePE(), 0), 0o644))
	if _, _, err := Open(p); !errors.Is(err, ErrNoPayload) {
		t.Errorf("signed launcher: %v", err)
	}
}

func TestPackStripsStubSignature(t *testing.T) {
	signedStub := sign(fakePE(), 0)
	out, data := packPE(t, signedStub)
	if binary.LittleEndian.Uint64(data[peSecEntry:]) != 0 {
		t.Fatal("setup file must not carry the stub's security directory")
	}
	if !bytes.HasPrefix(data, fakePE()[:peSecEntry]) {
		t.Fatal("setup prefix changed beyond the security entry")
	}
	x := extractOK(t, out)
	got, _ := os.ReadFile(x.LauncherPath)
	if !bytes.Equal(got, signedStub) {
		t.Fatal("the payload must keep the signed launcher")
	}
	// A signature that is not at the end of the stub cannot be stripped safely.
	odd := append(sign(fakePE(), 0), 0xAA)
	dir := t.TempDir()
	stubPath := filepath.Join(dir, "stub.exe")
	must(t, os.WriteFile(stubPath, odd, 0o755))
	must(t, os.MkdirAll(filepath.Join(dir, "p", "app-1.0.0"), 0o755))
	if _, err := Pack(PackOptions{Stub: stubPath, PayloadDir: filepath.Join(dir, "p"), Out: filepath.Join(dir, "o.exe")}); err == nil {
		t.Fatal("stub with a mid-file signature must be refused")
	}
}
