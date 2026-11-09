// Command launcher is MossStudio's launcher, setup stub and uninstall finisher in one
// binary (Windows: GUI subsystem, built with -H=windowsgui).
//
// Which mode runs:
//
//	<setup file> [args]                   the binary carries a payload: setup stub (package stub)
//	launcher pack --stub <bin> --payload <dir> --out <file> [--level 1-9]
//	                                      write a setup file (package payload)
//	launcher --launcher-version           print the launcher version
//	launcher --finish-uninstall=<plan> [--moss-silent]
//	                                      run an uninstall plan (package uninstall); with
//	                                      --moss-silent no dialog, problems go to stderr
//	launcher --uninstall [args]           start the current app with --moss-uninstall
//	launcher --restart [--pid=<pid>] [args]
//	                                      wait for pid (default: parent; --restart=<pid> also
//	                                      works) and the app's processes to exit, then launch
//	launcher [args]                       launch the current app (package launch)
//
// Every other argument is passed through to the app unchanged.
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ShallowElec/MossStudio/apps/launcher/internal/launch"
	"github.com/ShallowElec/MossStudio/apps/launcher/internal/payload"
	"github.com/ShallowElec/MossStudio/apps/launcher/internal/proc"
	"github.com/ShallowElec/MossStudio/apps/launcher/internal/record"
	"github.com/ShallowElec/MossStudio/apps/launcher/internal/stub"
	"github.com/ShallowElec/MossStudio/apps/launcher/internal/ui"
	"github.com/ShallowElec/MossStudio/apps/launcher/internal/uninstall"
)

// version is set at build time: -ldflags "-X main.version=<semver>".
var version = "0.0.0-dev"

const (
	restartArg         = "--restart"
	pidArg             = "--pid"
	uninstallArg       = "--uninstall"
	finishUninstallArg = launch.FinishUninstallArg
	versionArg         = "--launcher-version"
	dialogTitle        = "MossStudio"
)

func main() { os.Exit(run(os.Args[1:])) }

func selfPath() (string, error) {
	p, err := os.Executable()
	if err != nil {
		return "", err
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return filepath.Abs(p)
}

func run(args []string) int {
	self, err := selfPath()
	if err != nil {
		ui.Error(dialogTitle, "无法确定 MossStudio 的位置。", err.Error())
		return 1
	}
	if payload.HasPayload(self) {
		return runStub(self, args)
	}
	if len(args) > 0 {
		switch args[0] {
		case "pack":
			return runPack(args[1:], os.Stdout, os.Stderr)
		case versionArg:
			fmt.Println(version)
			return 0
		}
	}
	inv, err := parseArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "MossStudio: invalid arguments:", err)
		if !stub.Silent(args) {
			ui.Error(dialogTitle, "启动参数无效。", err.Error())
		}
		return 2
	}
	switch inv.mode {
	case modeFinishUninstall:
		return runFinishUninstall(self, inv.plan, finishAlert(stub.Silent(inv.rest)))
	}
	log := newLogger()
	env := &launch.Env{
		Root: filepath.Dir(self), Launcher: self, Platform: platformKey(),
		Runner: proc.ExecRunner{Chromium: true}, Clock: launch.RealClock{}, Running: proc.RunningUnder, Logf: log.printf,
	}
	if rec, err := record.Read(record.Path(env.Root)); err == nil {
		log.setFile(filepath.Join(rec.DataRoot, "logs", "launcher.log"))
	}
	defer log.close()
	log.printf("launcher %s: %s %q", version, inv.mode, inv.rest)
	var code int
	switch inv.mode {
	case modeUninstall:
		err = env.Uninstall(inv.rest)
	case modeRestart:
		pid := inv.pid
		if pid == 0 {
			pid = os.Getppid()
		}
		code, err = env.Restart(pid, proc.WaitPidExit, inv.rest)
	default:
		code, err = env.Launch(inv.rest)
	}
	if err != nil {
		log.printf("error: %v", err)
		showError(err)
		if code == 0 {
			code = 1
		}
	}
	return code
}

type mode string

const (
	modeLaunch          mode = "launch"
	modeRestart         mode = "restart"
	modeUninstall       mode = "uninstall"
	modeFinishUninstall mode = "finish-uninstall"
)

type invocation struct {
	mode mode
	pid  int
	plan string
	rest []string
}

// parseArgs takes out the launcher's own flags; everything else goes to the app.
func parseArgs(args []string) (invocation, error) {
	inv := invocation{mode: modeLaunch}
	set := func(m mode) error {
		if inv.mode != modeLaunch && inv.mode != m {
			return fmt.Errorf("%s and %s cannot be combined", inv.mode, m)
		}
		inv.mode = m
		return nil
	}
	for _, a := range args {
		switch {
		case a == restartArg:
			if err := set(modeRestart); err != nil {
				return inv, err
			}
		case strings.HasPrefix(a, restartArg+"="):
			pid, err := strconv.Atoi(strings.TrimPrefix(a, restartArg+"="))
			if err != nil || pid <= 0 {
				return inv, fmt.Errorf("invalid %s", a)
			}
			if err := set(modeRestart); err != nil {
				return inv, err
			}
			inv.pid = pid
		case strings.HasPrefix(a, pidArg+"="):
			pid, err := strconv.Atoi(strings.TrimPrefix(a, pidArg+"="))
			if err != nil || pid <= 0 {
				return inv, fmt.Errorf("invalid %s", a)
			}
			inv.pid = pid
		case a == uninstallArg:
			if err := set(modeUninstall); err != nil {
				return inv, err
			}
		case a == finishUninstallArg || strings.HasPrefix(a, finishUninstallArg+"="):
			plan := strings.TrimPrefix(a, finishUninstallArg+"=")
			if plan == "" || plan == a {
				return inv, fmt.Errorf("%s needs =<plan.json>", finishUninstallArg)
			}
			if err := set(modeFinishUninstall); err != nil {
				return inv, err
			}
			inv.plan = plan
		default:
			inv.rest = append(inv.rest, a)
		}
	}
	if inv.pid != 0 && inv.mode != modeRestart {
		return inv, fmt.Errorf("%s needs %s", pidArg, restartArg)
	}
	return inv, nil
}

func platformKey() string {
	if runtime.GOOS == "windows" {
		return "win32-x64"
	}
	return "linux-x64"
}

func showError(err error) {
	var le *launch.Error
	if errors.As(err, &le) {
		detail := le.Detail
		if le.Err != nil {
			if detail != "" {
				detail += "\n"
			}
			detail += le.Err.Error()
		}
		ui.Error(dialogTitle, le.Message, detail)
		return
	}
	ui.Error(dialogTitle, "MossStudio 遇到问题，无法继续。", err.Error())
}

func runStub(self string, args []string) int {
	silent := stub.Silent(args)
	splash := ui.NoSplash
	if !silent {
		splash = ui.ShowSplash()
	}
	code, err := stub.Run(stub.Options{Self: self, Args: args, Splash: splash, Runner: proc.ExecRunner{Chromium: true},
		Logf: func(f string, a ...any) { fmt.Fprintf(os.Stderr, f+"\n", a...) }})
	if err != nil {
		fmt.Fprintln(os.Stderr, "MossStudio setup:", err)
		if !silent {
			showError(err)
		}
	}
	return code
}

func runPack(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("pack", flag.ContinueOnError)
	fs.SetOutput(stderr)
	stubPath := fs.String("stub", "", "plain launcher binary (moss-launcher-win-x64.exe or moss-launcher-linux-x64)")
	payloadDir := fs.String("payload", "", "directory holding exactly one app-<version>/")
	out := fs.String("out", "", "setup file to write")
	level := fs.Int("level", 9, "gzip level 1-9")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *stubPath == "" || *payloadDir == "" || *out == "" || fs.NArg() != 0 || *level < 1 || *level > 9 {
		fs.Usage()
		return 2
	}
	res, err := payload.Pack(payload.PackOptions{Stub: *stubPath, PayloadDir: *payloadDir, Out: *out, Level: *level})
	if err != nil {
		fmt.Fprintln(stderr, "pack:", err)
		return 1
	}
	fmt.Fprintf(stdout, "wrote %s: version %s, launcher %s, payload %d bytes at %d, sha256 %x\n",
		*out, res.Version, res.LauncherName, res.Trailer.Size, res.Trailer.Offset, res.Trailer.SHA256)
	return 0
}

// finishAlert shows a finish-uninstall problem to the user, or, with --moss-silent (an
// unattended uninstall: no one to click a dialog), only writes it to stderr.
func finishAlert(silent bool) func(message, detail string) {
	return func(message, detail string) {
		fmt.Fprintf(os.Stderr, "MossStudio: %s\n%s\n", message, detail)
		if !silent {
			ui.Error(dialogTitle, message, detail)
		}
	}
}

// runFinishUninstall runs the plan; alert reports problems (a dialog, or stderr only when
// silent). Exit codes: 0 done, 1 refused, still running, or some files left.
func runFinishUninstall(self, planPath string, alert func(message, detail string)) int {
	logf := func(f string, a ...any) { fmt.Fprintf(os.Stderr, f+"\n", a...) }
	plan, err := uninstall.ReadPlan(planPath)
	if err == nil {
		err = uninstall.DefaultChecker(self).Validate(plan)
	}
	if err != nil {
		logf("uninstall plan refused: %v", err)
		alert("卸载计划无效，没有删除任何文件。", err.Error())
		return 1
	}
	r := &uninstall.Runner{Running: proc.RunningUnder, Sleep: time.Sleep, Now: time.Now, DeleteRegKey: uninstall.DeleteRegistryKey, Logf: logf}
	code := 0
	if err := r.Execute(plan); err != nil {
		logf("uninstall: %v", err)
		code = 1
		if errors.Is(err, uninstall.ErrStillRunning) {
			alert("MossStudio 仍在运行，没有删除任何文件。请关闭 MossStudio 后重新卸载。", err.Error())
			return code // keep the plan and the copy: nothing happened
		}
		alert("卸载已完成，但有些文件无法删除，可以手动删除它们。", err.Error())
	}
	files, dir := uninstall.SelfCleanup(self, planPath)
	if err := uninstall.DeleteSelf(files, dir); err != nil {
		logf("self-delete: %v", err)
	}
	return code
}

// logger writes to stderr and, once the data root is known, to <dataRoot>/logs/launcher.log
// (rotated to launcher.log.1 past 512 KiB). Lines logged before the file is set are kept and
// flushed into it.
type logger struct {
	mu      sync.Mutex
	f       *os.File
	pending []string
}

func newLogger() *logger { return &logger{} }

func (l *logger) printf(format string, args ...any) {
	line := time.Now().Format("2006-01-02T15:04:05.000Z07:00") + " " + fmt.Sprintf(format, args...) + "\n"
	l.mu.Lock()
	defer l.mu.Unlock()
	fmt.Fprint(os.Stderr, line)
	if l.f != nil {
		l.f.WriteString(line)
	} else if len(l.pending) < 100 {
		l.pending = append(l.pending, line)
	}
}

func (l *logger) setFile(path string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	if st, err := os.Stat(path); err == nil && st.Size() > 512<<10 {
		os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	l.f = f
	for _, line := range l.pending {
		f.WriteString(line)
	}
	l.pending = nil
}

func (l *logger) close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f != nil {
		l.f.Close()
		l.f = nil
	}
}
