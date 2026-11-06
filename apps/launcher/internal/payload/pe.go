package payload

import (
	"encoding/binary"
	"errors"
	"io"
)

// Authenticode signing appends a certificate table to a PE file and records it in the
// optional header's security data directory (entry 4, whose "address" is a file offset).
// A signed setup file is therefore [stub][payload][trailer][padding 0-7][certificates]: the
// trailer ends where the certificate table begins (after at most 7 zero alignment bytes),
// not at end of file.

const maxCertPadding = 7

// securityDir returns the file offset and size of a PE file's certificate table, the
// offset of the directory entry itself, and ok=false when b is not a PE file or carries no
// certificate table.
func securityDir(r io.ReaderAt, fileSize int64) (off, size, entry int64, ok bool) {
	var dos [64]byte
	if fileSize < int64(len(dos)) {
		return 0, 0, 0, false
	}
	if _, err := r.ReadAt(dos[:], 0); err != nil || dos[0] != 'M' || dos[1] != 'Z' {
		return 0, 0, 0, false
	}
	lfanew := int64(binary.LittleEndian.Uint32(dos[0x3c:]))
	var hdr [24 + 2]byte // signature, COFF header, optional header magic
	if lfanew <= 0 || lfanew+int64(len(hdr)) > fileSize {
		return 0, 0, 0, false
	}
	if _, err := r.ReadAt(hdr[:], lfanew); err != nil || string(hdr[:4]) != "PE\x00\x00" {
		return 0, 0, 0, false
	}
	optSize := int64(binary.LittleEndian.Uint16(hdr[4+16:]))
	opt := lfanew + 24
	var countAt, dirsAt int64
	switch binary.LittleEndian.Uint16(hdr[24:]) {
	case 0x10b: // PE32
		countAt, dirsAt = 92, 96
	case 0x20b: // PE32+
		countAt, dirsAt = 108, 112
	default:
		return 0, 0, 0, false
	}
	entry = opt + dirsAt + 4*8
	if entry+8 > opt+optSize || entry+8 > fileSize {
		return 0, 0, 0, false
	}
	var buf [8]byte
	if _, err := r.ReadAt(buf[:4], opt+countAt); err != nil || binary.LittleEndian.Uint32(buf[:4]) <= 4 {
		return 0, 0, 0, false
	}
	if _, err := r.ReadAt(buf[:], entry); err != nil {
		return 0, 0, 0, false
	}
	off = int64(binary.LittleEndian.Uint32(buf[0:]))
	size = int64(binary.LittleEndian.Uint32(buf[4:]))
	if off == 0 || size == 0 {
		return 0, 0, entry, false
	}
	return off, size, entry, true
}

// payloadEnds lists where the trailer may end: end of file, or, for a signed PE file, the
// start of its certificate table minus 0..7 zero alignment bytes.
func payloadEnds(r io.ReaderAt, fileSize int64) ([]int64, error) {
	off, size, _, signed := securityDir(r, fileSize)
	if !signed {
		return []int64{fileSize}, nil
	}
	if off < TrailerSize || off+size > fileSize {
		return nil, errors.New("the setup file's signature table lies outside the file")
	}
	ends := []int64{off}
	gap := make([]byte, maxCertPadding)
	n := int64(maxCertPadding)
	if off-TrailerSize < n {
		n = off - TrailerSize
	}
	if _, err := r.ReadAt(gap[:n], off-n); err != nil {
		return nil, err
	}
	for k := int64(1); k <= n && gap[n-k] == 0; k++ {
		ends = append(ends, off-k)
	}
	return ends, nil
}

// stripSignature returns a PE file without its certificate table (when the table is at the
// end of the file) and with the security directory entry cleared; unsigned files are
// returned unchanged. A signature anywhere else is an error.
func stripSignature(b []byte) ([]byte, error) {
	r := byteReaderAt(b)
	off, size, entry, signed := securityDir(r, int64(len(b)))
	if !signed {
		return b, nil
	}
	if off+size != int64(len(b)) {
		return nil, errors.New("stub signature table is not at the end of the file")
	}
	out := append([]byte(nil), b[:off]...)
	for i := entry; i < entry+8; i++ {
		out[i] = 0
	}
	return out, nil
}

type byteReaderAt []byte

func (b byteReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 || off > int64(len(b)) {
		return 0, io.EOF
	}
	n := copy(p, b[off:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}
