// Package proc starts child processes, waits for pids and lists the processes that run from
// a directory, behind small interfaces the launcher's tests replace with fakes.
package proc

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/CloverIris/MossStudio/apps/launcher/internal/fsutil"
)

// Process is a started child process.
type Process interface {
	Pid() int
	// Exited returns the exit code once the process has exited; done is false while it runs.
	Exited() (code int, done bool)
}

// Runner starts processes.
type Runner interface {
	// Start runs exe with args (argv[1:]) and the full environment env. It never goes
	// through a shell.
	Start(exe string, args, env []string) (Process, error)
}

// Info is one running process.
type Info struct {
	Pid int
	Exe string
}

// ExecRunner starts real processes with os/exec.
type ExecRunner struct {
	// Chromium: exe is the MossStudio (Electron) app, so add the Chromium switches it needs
	// on this machine (see sandboxArgs).
	Chromium bool
}

// Start implements Runner.
func (r ExecRunner) Start(exe string, args, env []string) (Process, error) {
	if r.Chromium {
		args = append(sandboxArgs(exe), args...)
	}
	cmd := exec.Command(exe, args...)
	cmd.Env = env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, os.Stdout, os.Stderr
	configureChild(cmd)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &execProcess{cmd: cmd, done: make(chan struct{})}
	go func() {
		err := cmd.Wait()
		code := 0
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		} else if err != nil {
			code = -1
		}
		p.mu.Lock()
		p.code, p.exited = code, true
		p.mu.Unlock()
		close(p.done)
	}()
	return p, nil
}

type execProcess struct {
	cmd    *exec.Cmd
	mu     sync.Mutex
	code   int
	exited bool
	done   chan struct{}
}

func (p *execProcess) Pid() int { return p.cmd.Process.Pid }

func (p *execProcess) Exited() (int, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.code, p.exited
}

// Wait blocks until the process exits and returns its exit code.
func Wait(p Process) int {
	if ep, ok := p.(*execProcess); ok {
		<-ep.done
		code, _ := ep.Exited()
		return code
	}
	for {
		if code, done := p.Exited(); done {
			return code
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// RunningUnder lists processes (other than this one) whose executable lies inside root.
func RunningUnder(root string) ([]Info, error) {
	all, err := List()
	if err != nil {
		return nil, err
	}
	self := os.Getpid()
	var out []Info
	for _, p := range all {
		if p.Pid != self && p.Exe != "" && fsutil.Inside(root, p.Exe, fsutil.FoldCase) {
			out = append(out, p)
		}
	}
	return out, nil
}
