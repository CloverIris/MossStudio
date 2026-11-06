package uninstall

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	shell32                  = syscall.NewLazyDLL("shell32.dll")
	ole32                    = syscall.NewLazyDLL("ole32.dll")
	procSHGetKnownFolderPath = shell32.NewProc("SHGetKnownFolderPath")
	procCoTaskMemFree        = ole32.NewProc("CoTaskMemFree")
	procGetLongPathNameW     = syscall.NewLazyDLL("kernel32.dll").NewProc("GetLongPathNameW")
	// FOLDERID_RoamingAppData {3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}
	folderRoamingAppData = syscall.GUID{Data1: 0x3EB685DB, Data2: 0x65F9, Data3: 0x4CF6, Data4: [8]byte{0xA0, 0x3A, 0xE3, 0xEF, 0x65, 0x72, 0x9F, 0x3D}}
	// FOLDERID_Desktop {B4BFCC3A-DB2C-424C-B029-7FE99A87C641}
	folderDesktop = syscall.GUID{Data1: 0xB4BFCC3A, Data2: 0xDB2C, Data3: 0x424C, Data4: [8]byte{0xB0, 0x29, 0x7F, 0xE9, 0x9A, 0x87, 0xC6, 0x41}}
)

// longPath expands 8.3 short names (GetLongPathNameW); p is returned unchanged on failure.
func longPath(p string) string {
	in, err := syscall.UTF16PtrFromString(p)
	if err != nil {
		return p
	}
	buf := make([]uint16, 32768)
	n, _, _ := procGetLongPathNameW.Call(uintptr(unsafe.Pointer(in)), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if n == 0 || int(n) > len(buf) {
		return p
	}
	return syscall.UTF16ToString(buf[:n])
}

func roamingAppData() string { return knownFolder(&folderRoamingAppData) }

func knownFolder(id *syscall.GUID) string {
	var p *uint16
	r, _, _ := procSHGetKnownFolderPath.Call(uintptr(unsafe.Pointer(id)), 0, 0, uintptr(unsafe.Pointer(&p)))
	if p == nil {
		return ""
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(p)))
	if r != 0 {
		return ""
	}
	n := 0
	for *(*uint16)(unsafe.Add(unsafe.Pointer(p), 2*n)) != 0 {
		n++
	}
	return syscall.UTF16ToString(unsafe.Slice(p, n))
}

// ProfileDir is Electron's userData folder for MossStudio on Windows: %APPDATA%\MossStudio,
// falling back to the Roaming known folder. "" when neither is absolute.
func ProfileDir() string {
	base := os.Getenv("APPDATA")
	if base == "" || !filepath.IsAbs(base) {
		base = roamingAppData()
	}
	if base == "" || !filepath.IsAbs(base) {
		return ""
	}
	return filepath.Join(base, "MossStudio")
}

// DefaultLocations are the Windows integration files, as integration.ts/layout.ts create
// them: <APPDATA>\Microsoft\Windows\Start Menu\Programs\MossStudio.lnk, <Desktop>\MossStudio.lnk
// (the Desktop known folder, as app.getPath('desktop')) and <LOCALAPPDATA>\MossStudio\locator.json.
func DefaultLocations(home string) Locations {
	var l Locations
	abs := func(v string) bool { return v != "" && filepath.IsAbs(v) }
	roaming := os.Getenv("APPDATA")
	if !abs(roaming) {
		roaming = roamingAppData()
	}
	if !abs(roaming) && home != "" {
		roaming = filepath.Join(home, "AppData", "Roaming")
	}
	if abs(roaming) {
		l.Integration = append(l.Integration, filepath.Join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "MossStudio.lnk"))
	}
	desktop := knownFolder(&folderDesktop)
	if !abs(desktop) && home != "" {
		desktop = filepath.Join(home, "Desktop")
	}
	if abs(desktop) {
		l.Integration = append(l.Integration, filepath.Join(desktop, "MossStudio.lnk"))
	}
	local := os.Getenv("LOCALAPPDATA")
	if !abs(local) && home != "" {
		local = filepath.Join(home, "AppData", "Local")
	}
	if abs(local) {
		l.LocatorDir = filepath.Join(local, "MossStudio")
		l.Integration = append(l.Integration, filepath.Join(l.LocatorDir, "locator.json"))
	}
	return l
}

const createNoWindow = 0x08000000

func system32(exe string) string {
	if root := os.Getenv("SystemRoot"); root != "" {
		return filepath.Join(root, "System32", exe)
	}
	return exe
}

func hidden(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= createNoWindow
}

// DeleteRegistryKey removes an HKCU key with reg.exe (argument array, no shell). A key
// that does not exist counts as removed.
func DeleteRegistryKey(key string) error {
	reg := system32("reg.exe")
	q := exec.Command(reg, "query", key)
	hidden(q)
	if err := q.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return nil // not found
		}
		return err
	}
	d := exec.Command(reg, "delete", key, "/f")
	hidden(d)
	if out, err := d.CombinedOutput(); err != nil {
		return fmt.Errorf("reg delete: %v: %s", err, out)
	}
	return nil
}

// DeleteSelf starts a hidden, detached cmd.exe that deletes files (this executable among
// them) and the empty folder dir once this process has exited.
func DeleteSelf(files []string, dir string) error {
	args, ok := WindowsSelfDeleteArgs(files, dir)
	if !ok {
		return errors.New("a path contains characters cmd.exe cannot take safely; leaving the temp copy")
	}
	cmdExe := system32("cmd.exe")
	cmd := exec.Command(cmdExe, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: WindowsCmdLine(cmdExe, args)}
	hidden(cmd)
	cmd.Dir = os.TempDir() // never keep the folder being deleted busy
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
