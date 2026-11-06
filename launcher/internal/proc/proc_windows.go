package proc

import (
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

var (
	kernel32                       = syscall.NewLazyDLL("kernel32.dll")
	procQueryFullProcessImageNameW = kernel32.NewProc("QueryFullProcessImageNameW")
)

const (
	processQueryLimitedInformation = 0x1000
	synchronize                    = 0x00100000
	waitTimeout                    = 0x00000102
)

func configureChild(cmd *exec.Cmd) {}

// List returns every process whose image path this user may query.
func List() ([]Info, error) {
	snap, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer syscall.CloseHandle(snap)
	var e syscall.ProcessEntry32
	e.Size = uint32(unsafe.Sizeof(e))
	var out []Info
	for err = syscall.Process32First(snap, &e); err == nil; err = syscall.Process32Next(snap, &e) {
		pid := e.ProcessID
		if pid == 0 {
			continue
		}
		if exe := imagePath(pid); exe != "" {
			out = append(out, Info{Pid: int(pid), Exe: exe})
		}
	}
	return out, nil
}

func imagePath(pid uint32) string {
	h, err := syscall.OpenProcess(processQueryLimitedInformation, false, pid)
	if err != nil {
		return ""
	}
	defer syscall.CloseHandle(h)
	buf := make([]uint16, 32768)
	size := uint32(len(buf))
	r, _, _ := procQueryFullProcessImageNameW.Call(uintptr(h), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if r == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:size])
}

// Alive reports whether pid exists and has not exited.
func Alive(pid int) bool {
	h, err := syscall.OpenProcess(synchronize|processQueryLimitedInformation, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	ev, _ := syscall.WaitForSingleObject(h, 0)
	return ev == waitTimeout
}

// WaitPidExit waits until pid is gone or timeout passes; it reports whether the pid exited.
func WaitPidExit(pid int, timeout time.Duration) bool {
	h, err := syscall.OpenProcess(synchronize, false, uint32(pid))
	if err != nil {
		return true // no such process (or already gone)
	}
	defer syscall.CloseHandle(h)
	ev, _ := syscall.WaitForSingleObject(h, uint32(timeout/time.Millisecond))
	return ev != waitTimeout
}
