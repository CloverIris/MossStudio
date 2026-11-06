// Package winres writes a Windows resource object (.syso, a COFF object with one .rsrc
// section) that the Go linker merges into the executable: the app icon (RT_ICON +
// RT_GROUP_ICON id 1), version information (RT_VERSION) and an application manifest
// (RT_MANIFEST id 1). Pure Go, no C toolchain.
//
// The manifest matters beyond DPI: without requestedExecutionLevel, Windows' installer
// detection elevates any exe whose name contains "setup", which would put a UAC prompt in
// front of the per-user MossStudio-Setup-<v>-x64.exe.
package winres

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// Resource types and the language used for every resource (en-US; Explorer falls back).
const (
	rtIcon      = 3
	rtGroupIcon = 14
	rtVersion   = 16
	rtManifest  = 24
	langID      = 0x0409

	// IconGroupID is the resource id of the app icon group (MAKEINTRESOURCE(1)).
	IconGroupID = 1
)

// Info describes the executable for the version resource.
type Info struct {
	Version     string // semver; numeric part goes into the fixed version
	Company     string
	Product     string
	Description string
	Copyright   string
	FileName    string // OriginalFilename
}

type resource struct {
	typ, id uint16
	data    []byte
}

// Build returns the .syso bytes for an amd64 executable.
func Build(ico []byte, info Info) ([]byte, error) {
	images, group, err := splitICO(ico)
	if err != nil {
		return nil, err
	}
	var res []resource
	for i, img := range images {
		res = append(res, resource{rtIcon, uint16(i + 1), img})
	}
	res = append(res, resource{rtGroupIcon, IconGroupID, group})
	ver, err := versionInfo(info)
	if err != nil {
		return nil, err
	}
	res = append(res, resource{rtVersion, 1, ver})
	res = append(res, resource{rtManifest, 1, []byte(Manifest)})
	return coff(res), nil
}

// Manifest is the embedded application manifest.
const Manifest = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="CloverIris.MossStudio.Launcher" version="1.0.0.0" processorArchitecture="amd64"/>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
    </windowsSettings>
  </application>
</assembly>
`

// splitICO turns an .ico file into RT_ICON payloads and the RT_GROUP_ICON directory.
func splitICO(ico []byte) ([][]byte, []byte, error) {
	if len(ico) < 6 || binary.LittleEndian.Uint16(ico[0:]) != 0 || binary.LittleEndian.Uint16(ico[2:]) != 1 {
		return nil, nil, errors.New("not an .ico file")
	}
	n := int(binary.LittleEndian.Uint16(ico[4:]))
	if n == 0 || len(ico) < 6+16*n {
		return nil, nil, errors.New("truncated .ico directory")
	}
	var group bytes.Buffer
	binary.Write(&group, binary.LittleEndian, [3]uint16{0, 1, uint16(n)})
	var images [][]byte
	for i := 0; i < n; i++ {
		e := ico[6+16*i : 22+16*i]
		size := binary.LittleEndian.Uint32(e[8:])
		off := binary.LittleEndian.Uint32(e[12:])
		if uint64(off)+uint64(size) > uint64(len(ico)) || size == 0 {
			return nil, nil, fmt.Errorf(".ico image %d out of bounds", i)
		}
		images = append(images, ico[off:off+size])
		group.Write(e[0:12])                                   // width..bytesInRes
		binary.Write(&group, binary.LittleEndian, uint16(i+1)) // nID
	}
	return images, group.Bytes(), nil
}

// versionNumbers parses the numeric part of a semver into four 16-bit fields.
func versionNumbers(v string) ([4]uint16, error) {
	var out [4]uint16
	core, _, _ := strings.Cut(v, "-")
	core, _, _ = strings.Cut(core, "+")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return out, fmt.Errorf("version %q is not semver", v)
	}
	for i, p := range parts {
		n, err := strconv.ParseUint(p, 10, 16)
		if err != nil {
			return out, fmt.Errorf("version %q: %v", v, err)
		}
		out[i] = uint16(n)
	}
	return out, nil
}

func utf16z(s string) []byte {
	u := utf16.Encode([]rune(s))
	b := make([]byte, 2*len(u)+2)
	for i, c := range u {
		binary.LittleEndian.PutUint16(b[2*i:], c)
	}
	return b
}

func pad4(b *bytes.Buffer) {
	for b.Len()%4 != 0 {
		b.WriteByte(0)
	}
}

// block writes one VS_VERSIONINFO-style node: wLength, wValueLength, wType, szKey, padding,
// value, padding, children. valueLen is in the unit the node type requires.
func block(key string, value []byte, valueLen uint16, text bool, children ...[]byte) []byte {
	var b bytes.Buffer
	b.Write([]byte{0, 0}) // wLength, patched below
	binary.Write(&b, binary.LittleEndian, valueLen)
	typ := uint16(0)
	if text {
		typ = 1
	}
	binary.Write(&b, binary.LittleEndian, typ)
	b.Write(utf16z(key))
	pad4(&b)
	b.Write(value)
	for _, c := range children {
		pad4(&b)
		b.Write(c)
	}
	out := b.Bytes()
	binary.LittleEndian.PutUint16(out[0:], uint16(len(out)))
	return out
}

func versionInfo(info Info) ([]byte, error) {
	nums, err := versionNumbers(info.Version)
	if err != nil {
		return nil, err
	}
	ms := uint32(nums[0])<<16 | uint32(nums[1])
	ls := uint32(nums[2])<<16 | uint32(nums[3])
	var fixed bytes.Buffer
	binary.Write(&fixed, binary.LittleEndian, []uint32{
		0xFEEF04BD, 0x00010000, // signature, struct version
		ms, ls, ms, ls, // file version, product version
		0x3F, 0, // flags mask, flags
		0x00040004, // VOS_NT_WINDOWS32
		1,          // VFT_APP
		0, 0, 0,    // subtype, date
	})
	strs := []struct{ k, v string }{
		{"CompanyName", info.Company},
		{"FileDescription", info.Description},
		{"FileVersion", info.Version},
		{"InternalName", strings.TrimSuffix(info.FileName, ".exe")},
		{"LegalCopyright", info.Copyright},
		{"OriginalFilename", info.FileName},
		{"ProductName", info.Product},
		{"ProductVersion", info.Version},
	}
	var strings_ [][]byte
	for _, s := range strs {
		if s.v == "" {
			continue
		}
		v := utf16z(s.v)
		strings_ = append(strings_, block(s.k, v, uint16(len(v)/2), true))
	}
	table := block("040904B0", nil, 0, true, strings_...)
	sfi := block("StringFileInfo", nil, 0, true, table)
	var trans bytes.Buffer
	binary.Write(&trans, binary.LittleEndian, []uint16{langID, 1200})
	vfi := block("VarFileInfo", nil, 0, true, block("Translation", trans.Bytes(), 4, false))
	return block("VS_VERSION_INFO", fixed.Bytes(), uint16(fixed.Len()), false, sfi, vfi), nil
}

// coff lays the resources out as a three-level resource directory (type → id → language)
// in one .rsrc section and wraps it in an AMD64 COFF object. Each data entry's RVA is a
// section offset fixed up by an IMAGE_REL_AMD64_ADDR32NB relocation against the section.
func coff(res []resource) []byte {
	sort.SliceStable(res, func(i, j int) bool {
		if res[i].typ != res[j].typ {
			return res[i].typ < res[j].typ
		}
		return res[i].id < res[j].id
	})
	type typeGroup struct {
		typ uint16
		ids []int // indexes into res
	}
	var groups []typeGroup
	for i, r := range res {
		if len(groups) == 0 || groups[len(groups)-1].typ != r.typ {
			groups = append(groups, typeGroup{typ: r.typ})
		}
		groups[len(groups)-1].ids = append(groups[len(groups)-1].ids, i)
	}
	const dirSize, entSize, dataEntSize = 16, 8, 16
	// Offsets: root dir, then one dir per type, then one dir per (type,id), then data entries.
	off := dirSize + entSize*len(groups)
	typeDirOff := make([]int, len(groups))
	for g := range groups {
		typeDirOff[g] = off
		off += dirSize + entSize*len(groups[g].ids)
	}
	langDirOff := make([]int, len(res))
	for i := range res {
		langDirOff[i] = off
		off += dirSize + entSize
	}
	dataEntOff := make([]int, len(res))
	for i := range res {
		dataEntOff[i] = off
		off += dataEntSize
	}
	dataOff := make([]int, len(res))
	for i := range res {
		off = (off + 7) &^ 7
		dataOff[i] = off
		off += len(res[i].data)
	}
	sect := make([]byte, (off+7)&^7)
	le := binary.LittleEndian
	writeDir := func(at, nIDs int) { le.PutUint16(sect[at+14:], uint16(nIDs)) }
	writeEnt := func(at int, id uint32, target int, subdir bool) {
		le.PutUint32(sect[at:], id)
		t := uint32(target)
		if subdir {
			t |= 0x80000000
		}
		le.PutUint32(sect[at+4:], t)
	}
	writeDir(0, len(groups))
	for g, grp := range groups {
		writeEnt(dirSize+entSize*g, uint32(grp.typ), typeDirOff[g], true)
		writeDir(typeDirOff[g], len(grp.ids))
		for k, i := range grp.ids {
			writeEnt(typeDirOff[g]+dirSize+entSize*k, uint32(res[i].id), langDirOff[i], true)
		}
	}
	var relocs []uint32
	for i, r := range res {
		writeDir(langDirOff[i], 1)
		writeEnt(langDirOff[i]+dirSize, langID, dataEntOff[i], false)
		le.PutUint32(sect[dataEntOff[i]:], uint32(dataOff[i])) // RVA, relocated
		le.PutUint32(sect[dataEntOff[i]+4:], uint32(len(r.data)))
		relocs = append(relocs, uint32(dataEntOff[i]))
		copy(sect[dataOff[i]:], r.data)
	}

	const fileHdr, sectHdr, relocSize, symSize = 20, 40, 10, 18
	rawPtr := fileHdr + sectHdr
	relocPtr := rawPtr + len(sect)
	symPtr := relocPtr + relocSize*len(relocs)
	var out bytes.Buffer
	w := func(v any) { binary.Write(&out, le, v) }
	// IMAGE_FILE_HEADER
	w(uint16(0x8664)) // AMD64
	w(uint16(1))      // sections
	w(uint32(0))      // timestamp (reproducible)
	w(uint32(symPtr))
	w(uint32(1)) // symbols
	w(uint16(0)) // optional header
	w(uint16(0)) // characteristics
	// IMAGE_SECTION_HEADER
	out.WriteString(".rsrc\x00\x00\x00")
	w(uint32(0)) // virtual size
	w(uint32(0)) // virtual address
	w(uint32(len(sect)))
	w(uint32(rawPtr))
	w(uint32(relocPtr))
	w(uint32(0)) // line numbers
	w(uint16(len(relocs)))
	w(uint16(0))
	w(uint32(0x40000040)) // INITIALIZED_DATA | MEM_READ
	out.Write(sect)
	for _, r := range relocs {
		w(r)         // offset of the field in the section
		w(uint32(0)) // symbol 0: the section symbol
		w(uint16(3)) // IMAGE_REL_AMD64_ADDR32NB
	}
	// Symbol 0: ".rsrc", section 1, static, no aux.
	out.WriteString(".rsrc\x00\x00\x00")
	w(uint32(0))
	w(uint16(1))
	w(uint16(0))
	out.WriteByte(3)
	out.WriteByte(0)
	w(uint32(4)) // empty string table
	return out.Bytes()
}
