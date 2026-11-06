// Package payload defines the setup stub's appended payload: how it is packed, found,
// verified and safely extracted.
//
// # File layout
//
// A setup file (MossStudio-Setup-<v>-x64.exe, MossStudio-Setup-<v>-linux-x64.run) is
//
//	[ launcher binary, unchanged ][ payload: gzip-compressed POSIX tar ][ trailer, 64 bytes ]
//
// The trailer is the last TrailerSize bytes of the file, all integers little-endian:
//
//	offset size field
//	     0    8 payload offset: first byte of the payload, from the start of the file
//	     8    8 payload size in bytes
//	    16   32 SHA-256 of the payload bytes
//	    48    4 format version (FormatVersion = 1)
//	    52    4 reserved, zero
//	    56    8 magic "MossPay1"
//
// A file is a valid setup file only if the magic and version match and
// offset + size + TrailerSize equals the file size — or, for an Authenticode-signed PE file,
// the offset of its certificate table (security data directory), less 0-7 zero alignment
// bytes. Pack pads the payload with zeros so the file length is a multiple of 8, so signing
// needs no padding; the gzip reader ignores the zeros after the stream. The launcher binary itself carries no
// trailer, so the same executable is the launcher (no trailer) or the setup stub (trailer).
//
// # Archive contents
//
// The tar holds exactly one app directory and the payload-less launcher:
//
//	app-<version>/...          the app folder (app-<v>/MossStudio.exe or app-<v>/MossStudio)
//	MossStudio.exe | mossstudio the launcher, copied into the install root by the app
//
// Allowed entry types are directories, regular files and symlinks. Entry names use "/",
// are relative, and contain no "..", "\", ":" or NUL. Symlink targets are relative and must
// resolve (for real, after extraction) to an existing path inside the archive. Modes
// (permission bits only) are preserved on Linux. Packing is deterministic: entries sorted,
// uid/gid 0, zero mtimes, no gzip name or time.
//
// # Verification
//
// The stub hashes the whole payload and compares it with the trailer before it extracts a
// single byte; any mismatch is ErrTampered.
package payload

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
)

const (
	// TrailerSize is the fixed size of the trailer at the end of a setup file.
	TrailerSize = 64
	// FormatVersion is the trailer version this code writes and reads.
	FormatVersion = 1
	// Magic ends every setup file.
	Magic = "MossPay1"
)

var (
	// ErrNoPayload means the file has no trailer: it is a plain launcher.
	ErrNoPayload = errors.New("no payload")
	// ErrTampered means the trailer is present but the payload's hash does not match.
	ErrTampered = errors.New("payload checksum mismatch: the setup file is damaged or was modified")
)

// Trailer describes where the payload sits in a setup file.
type Trailer struct {
	Offset  int64
	Size    int64
	SHA256  [32]byte
	Version uint32
}

// Encode returns the 64 trailer bytes.
func (t Trailer) Encode() []byte {
	b := make([]byte, TrailerSize)
	binary.LittleEndian.PutUint64(b[0:], uint64(t.Offset))
	binary.LittleEndian.PutUint64(b[8:], uint64(t.Size))
	copy(b[16:48], t.SHA256[:])
	binary.LittleEndian.PutUint32(b[48:], t.Version)
	copy(b[56:], Magic)
	return b
}

// DecodeTrailer parses trailer bytes and checks them against end, the offset where the
// trailer ends (the file size, or a signed file's certificate table offset).
func DecodeTrailer(b []byte, fileSize int64) (Trailer, error) {
	if len(b) != TrailerSize || !bytes.Equal(b[56:], []byte(Magic)) {
		return Trailer{}, ErrNoPayload
	}
	t := Trailer{
		Offset:  int64(binary.LittleEndian.Uint64(b[0:])),
		Size:    int64(binary.LittleEndian.Uint64(b[8:])),
		Version: binary.LittleEndian.Uint32(b[48:]),
	}
	copy(t.SHA256[:], b[16:48])
	if t.Version != FormatVersion {
		return Trailer{}, fmt.Errorf("unsupported payload format version %d", t.Version)
	}
	if binary.LittleEndian.Uint32(b[52:]) != 0 {
		return Trailer{}, errors.New("payload trailer: reserved field is not zero")
	}
	if t.Offset < 0 || t.Size <= 0 || t.Offset > fileSize || t.Size > fileSize ||
		t.Offset+t.Size+TrailerSize != fileSize {
		return Trailer{}, fmt.Errorf("payload trailer does not match the file size (offset %d, size %d, file %d)", t.Offset, t.Size, fileSize)
	}
	return t, nil
}

// ReadTrailer returns the trailer of the open file f, or ErrNoPayload. The trailer ends at
// end of file or, on an Authenticode-signed PE file, where its certificate table begins
// (see pe.go).
func ReadTrailer(f io.ReaderAt, fileSize int64) (Trailer, error) {
	ends, err := payloadEnds(f, fileSize)
	if err != nil {
		return Trailer{}, err
	}
	var last error = ErrNoPayload
	for _, end := range ends {
		if end < TrailerSize {
			continue
		}
		b := make([]byte, TrailerSize)
		if _, err := f.ReadAt(b, end-TrailerSize); err != nil {
			return Trailer{}, err
		}
		t, err := DecodeTrailer(b, end)
		if err == nil {
			return t, nil
		}
		if !errors.Is(err, ErrNoPayload) {
			last = err
		}
	}
	return Trailer{}, last
}

// Open opens a setup file and returns it with its trailer. A plain launcher yields
// ErrNoPayload.
func Open(path string) (*os.File, Trailer, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, Trailer{}, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, Trailer{}, err
	}
	t, err := ReadTrailer(f, st.Size())
	if err != nil {
		f.Close()
		return nil, Trailer{}, err
	}
	return f, t, nil
}

// HasPayload reports whether the file at path carries a valid trailer.
func HasPayload(path string) bool {
	f, _, err := Open(path)
	if err != nil {
		return false
	}
	f.Close()
	return true
}

// Verify hashes the payload and compares it with the trailer. progress (may be nil) is
// called with the number of bytes hashed so far.
func Verify(f io.ReaderAt, t Trailer, progress func(done int64)) error {
	h := sha256.New()
	r := io.NewSectionReader(f, t.Offset, t.Size)
	if _, err := io.Copy(h, &countingReader{r: r, fn: progress}); err != nil {
		return fmt.Errorf("read payload: %w", err)
	}
	var sum [32]byte
	copy(sum[:], h.Sum(nil))
	if sum != t.SHA256 {
		return ErrTampered
	}
	return nil
}

type countingReader struct {
	r    io.Reader
	n    int64
	fn   func(int64)
	last int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	if c.fn != nil && (c.n-c.last >= 256<<10 || err != nil) {
		c.last = c.n
		c.fn(c.n)
	}
	return n, err
}
