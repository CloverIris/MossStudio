package proc

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRunnerListAndWait(t *testing.T) {
	root := filepath.Join(t.TempDir(), "根 R")
	os.MkdirAll(root, 0o755)
	sleepBin, _ := os.ReadFile("/bin/sleep")
	exe := filepath.Join(root, "sleeper")
	if err := os.WriteFile(exe, sleepBin, 0o755); err != nil {
		t.Fatal(err)
	}
	p, err := ExecRunner{}.Start(exe, []string{"0.5"}, os.Environ())
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	list, err := RunningUnder(root)
	if err != nil || len(list) != 1 || list[0].Pid != p.Pid() {
		t.Fatalf("RunningUnder = %v, %v", list, err)
	}
	if !Alive(p.Pid()) {
		t.Fatal("child should be alive")
	}
	if _, done := p.Exited(); done {
		t.Fatal("exited too early")
	}
	if code := Wait(p); code != 0 {
		t.Fatalf("exit code %d", code)
	}
	if list, _ := RunningUnder(root); len(list) != 0 {
		t.Fatalf("still listed: %v", list)
	}
	q, _ := ExecRunner{}.Start("/bin/sh", []string{"-c", "exit 4"}, nil)
	if code := Wait(q); code != 4 {
		t.Fatalf("exit code %d", code)
	}
	k, _ := ExecRunner{}.Start("/bin/sh", []string{"-c", "kill -9 $$"}, nil)
	if code := Wait(k); code == 0 {
		t.Fatal("a process killed by a signal must not report 0")
	}
	if !WaitPidExit(q.Pid(), time.Second) {
		t.Fatal("WaitPidExit on a reaped pid")
	}
}
