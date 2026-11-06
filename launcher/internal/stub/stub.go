// Package stub runs the setup stub: a launcher binary with a payload appended (see package
// payload for the format).
//
// Sequence: show the splash (unless --moss-silent), verify the payload's SHA-256, extract it
// into a fresh temp dir P (MossStudio-Setup-*, under the system temp folder or, when that is
// mounted noexec, under ${XDG_CACHE_HOME:-~/.cache}), start
//
//	P/app-<v>/MossStudio(.exe) --moss-setup=<P> <all stub arguments>
//
// close the splash when P/.ready appears (the app writes it once its window is up) or the
// app exits, wait for the app, remove P and exit with the app's exit code.
//
// Exit codes of the stub itself: ExitDamaged (payload missing or checksum mismatch),
// ExitExtract (could not create or fill P), ExitStart (could not start the app).
package stub

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/CloverIris/MossStudio/launcher/internal/launch"
	"github.com/CloverIris/MossStudio/launcher/internal/payload"
	"github.com/CloverIris/MossStudio/launcher/internal/proc"
	"github.com/CloverIris/MossStudio/launcher/internal/ui"
)

// Stub exit codes (the app's own code is passed through otherwise).
const (
	ExitDamaged = 90
	ExitExtract = 91
	ExitStart   = 92
)

// ReadyFile is written by the app into the payload dir once its window is visible.
const ReadyFile = ".ready"

// Options configure Run.
type Options struct {
	Self    string   // the setup file
	Args    []string // the stub's arguments, passed through to the app
	Splash  ui.Splash
	Runner  proc.Runner
	TempDir string // parent for P; "" = TempParent(os.TempDir(), …)
	// NoExec reports whether a folder is on a noexec mount; nil = the real check (Linux statfs).
	NoExec func(dir string) bool
	GOOS   string // "" = runtime.GOOS
	Logf   func(format string, args ...any)
	Poll   time.Duration // .ready / exit polling; 0 = 100ms
}

// Silent reports whether args ask for an unattended install.
func Silent(args []string) bool {
	for _, a := range args {
		if a == launch.SilentArg {
			return true
		}
	}
	return false
}

func (o *Options) logf(format string, args ...any) {
	if o.Logf != nil {
		o.Logf(format, args...)
	}
}

// Run executes the stub and returns its exit code; err is set (with a user-facing
// *launch.Error) when the stub itself failed.
func Run(o Options) (int, error) {
	splash := o.Splash
	if splash == nil {
		splash = ui.NoSplash
	}
	defer splash.Close()
	goos := o.GOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	launcherName, appExe := payload.LauncherNameLinux, "MossStudio"
	if goos == "windows" {
		launcherName, appExe = payload.LauncherNameWindows, "MossStudio.exe"
	}

	f, t, err := payload.Open(o.Self)
	if err != nil {
		return ExitDamaged, &launch.Error{Message: "安装程序已损坏，请重新下载 MossStudio 安装程序。", Detail: o.Self, Err: err}
	}
	defer f.Close()
	parent := o.TempDir
	if parent == "" {
		noexec := o.NoExec
		if noexec == nil {
			noexec = mountedNoExec
		}
		parent = TempParent(os.TempDir(), noexec, os.Getenv, os.UserHomeDir)
	}
	dir, err := os.MkdirTemp(parent, "MossStudio-Setup-")
	if err != nil {
		return ExitExtract, &launch.Error{Message: "无法创建临时文件夹，安装无法继续。请检查磁盘空间后重试。", Err: err}
	}
	defer removeAll(dir, o)

	x, err := payload.ExtractFile(f, t, dir, launcherName, splash.SetProgress)
	switch {
	case errors.Is(err, payload.ErrTampered):
		return ExitDamaged, &launch.Error{Message: "安装程序已损坏或被修改，请重新下载 MossStudio 安装程序。", Detail: o.Self, Err: err}
	case err != nil:
		return ExitExtract, &launch.Error{Message: "解压安装文件失败。请检查磁盘空间后重试。", Detail: dir, Err: err}
	}
	f.Close()

	exe := filepath.Join(x.AppDir, appExe)
	args := append([]string{launch.SetupArg + "=" + dir}, o.Args...)
	p, err := o.Runner.Start(exe, args, childEnv(goos))
	if err != nil {
		return ExitStart, &launch.Error{Message: "无法启动 MossStudio 安装程序。", Detail: exe, Err: err}
	}
	poll := o.Poll
	if poll == 0 {
		poll = 100 * time.Millisecond
	}
	ready := filepath.Join(dir, ReadyFile)
	for {
		if code, done := p.Exited(); done {
			o.logf("setup app exited with %d", code)
			return code, nil
		}
		if _, err := os.Stat(ready); err == nil {
			splash.Close()
		}
		time.Sleep(poll)
	}
}

// TempParent picks the folder P is created in: the system temp folder, unless it is mounted
// noexec (the app could not run from it); then ${XDG_CACHE_HOME:-~/.cache}, created if needed.
func TempParent(tmp string, noexec func(string) bool, getenv func(string) string, home func() (string, error)) string {
	if !noexec(tmp) {
		return tmp
	}
	cache := getenv("XDG_CACHE_HOME")
	if cache == "" || !filepath.IsAbs(cache) {
		h, err := home()
		if err != nil || !filepath.IsAbs(h) {
			return tmp
		}
		cache = filepath.Join(h, ".cache")
	}
	if err := os.MkdirAll(cache, 0o700); err != nil || noexec(cache) {
		return tmp
	}
	return cache
}

// childEnv drops the launcher's variables: the setup app is not an installed launch.
func childEnv(goos string) []string {
	var out []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if goos == "windows" {
			k = strings.ToUpper(k)
		}
		if k == launch.EnvRoot || k == launch.EnvLauncher {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// removeAll deletes the payload dir, retrying while helper processes release files.
func removeAll(dir string, o Options) {
	var err error
	for i := 0; i < 40; i++ {
		if err = os.RemoveAll(dir); err == nil {
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
	o.logf("could not remove %s: %v", dir, err)
}
