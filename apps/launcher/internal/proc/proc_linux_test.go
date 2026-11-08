package proc

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// sleeperEnv makes the test binary a process that only sleeps (TestSleeper).
const sleeperEnv = "MOSS_PROC_TEST_SLEEPER"

// TestSleeper is the process TestRunnerListAndWait runs: a copy of this test
// binary under another name. Not a copy of /bin/sleep: where coreutils is one
// multi-call binary (uutils, Ubuntu 26.04) a renamed copy refuses to run.
func TestSleeper(t *testing.T) {
	if os.Getenv(sleeperEnv) != "1" {
		t.Skip("only runs as TestRunnerListAndWait's child")
	}
	time.Sleep(500 * time.Millisecond)
	os.Exit(0)
}

func TestRunnerListAndWait(t *testing.T) {
	root := filepath.Join(t.TempDir(), "根 R")
	os.MkdirAll(root, 0o755)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bin, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	exe := filepath.Join(root, "sleeper")
	if err := os.WriteFile(exe, bin, 0o755); err != nil {
		t.Fatal(err)
	}
	p, err := ExecRunner{}.Start(exe, []string{"-test.run=^TestSleeper$"}, append(os.Environ(), sleeperEnv+"=1"))
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
