//go:build !windows

package proc

import (
	"errors"
	"os/exec"
	"syscall"
	"time"
)

func configureChild(cmd *exec.Cmd) {}

// Alive reports whether pid exists.
func Alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// WaitPidExit waits until pid is gone or timeout passes; it reports whether the pid exited.
func WaitPidExit(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for Alive(pid) {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
	return true
}
