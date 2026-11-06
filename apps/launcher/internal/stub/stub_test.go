package stub

import (
	"bytes"
	"compress/gzip"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/CloverIris/MossStudio/apps/launcher/internal/launch"
	"github.com/CloverIris/MossStudio/apps/launcher/internal/payload"
	"github.com/CloverIris/MossStudio/apps/launcher/internal/proc"
)

type recSplash struct {
	mu       sync.Mutex
	last     int64
	total    int64
	closedAt time.Time
	closes   int
}

func (s *recSplash) SetProgress(d, t int64) { s.mu.Lock(); s.last, s.total = d, t; s.mu.Unlock() }
func (s *recSplash) Close() {
	s.mu.Lock()
	if s.closes == 0 {
		s.closedAt = time.Now()
	}
	s.closes++
	s.mu.Unlock()
}

// makeSetup packs a setup file whose app is a shell script (the test runs it for real).
func makeSetup(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	app := filepath.Join(dir, "payload", "app-2.0.0")
	if err := os.MkdirAll(app, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, "MossStudio"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	stubBin := filepath.Join(dir, "stub")
	os.WriteFile(stubBin, append([]byte("\x7fELF"), bytes.Repeat([]byte{1}, 1000)...), 0o755)
	out := filepath.Join(dir, "MossStudio-Setup-2.0.0-linux-x64.run")
	if _, err := payload.Pack(payload.PackOptions{Stub: stubBin, PayloadDir: filepath.Join(dir, "payload"), Out: out, Level: gzip.BestSpeed}); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestRunRejectsTamperedSetup(t *testing.T) {
	setup := makeSetup(t, "#!/bin/sh\nexit 0\n")
	data, _ := os.ReadFile(setup)
	data[1100] ^= 0xff
	os.WriteFile(setup, data, 0o755)
	tmp := t.TempDir()
	started := false
	code, err := Run(Options{Self: setup, Runner: runnerFunc(func() { started = true }), TempDir: tmp})
	var le *launch.Error
	if code != ExitDamaged || !errors.As(err, &le) || !errors.Is(err, payload.ErrTampered) || started {
		t.Fatalf("code %d err %v started %v", code, err, started)
	}
	if ents, _ := os.ReadDir(tmp); len(ents) != 0 {
		t.Errorf("temp dir not removed: %v", ents)
	}
}

func TestRunWithoutPayload(t *testing.T) {
	plain := filepath.Join(t.TempDir(), "plain")
	os.WriteFile(plain, []byte("\x7fELF plain launcher"), 0o755)
	code, err := Run(Options{Self: plain, Runner: runnerFunc(func() {})})
	if code != ExitDamaged || !errors.Is(err, payload.ErrNoPayload) {
		t.Fatalf("code %d err %v", code, err)
	}
}

func TestSilent(t *testing.T) {
	if !Silent([]string{"--x", "--moss-silent"}) || Silent([]string{"--moss-silent=1"}) {
		t.Fatal("Silent")
	}
}

type runnerFunc func()

func (f runnerFunc) Start(string, []string, []string) (proc.Process, error) {
	f()
	return nil, errors.New("not started")
}

func TestTempParentAvoidsNoexecTmp(t *testing.T) {
	tmp := t.TempDir()
	home := t.TempDir()
	cacheEnv := filepath.Join(t.TempDir(), "xdg-cache")
	noexecTmp := func(d string) bool { return d == tmp }
	homeFn := func() (string, error) { return home, nil }
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

	if got := TempParent(tmp, func(string) bool { return false }, env(nil), homeFn); got != tmp {
		t.Fatalf("exec-able tmp: %s", got)
	}
	if got := TempParent(tmp, noexecTmp, env(map[string]string{"XDG_CACHE_HOME": cacheEnv}), homeFn); got != cacheEnv {
		t.Fatalf("XDG cache: %s", got)
	}
	if st, err := os.Stat(cacheEnv); err != nil || !st.IsDir() {
		t.Fatal("cache dir should be created")
	}
	if got := TempParent(tmp, noexecTmp, env(map[string]string{"XDG_CACHE_HOME": "relative"}), homeFn); got != filepath.Join(home, ".cache") {
		t.Fatalf("~/.cache: %s", got)
	}
	// Everything noexec: stay with tmp (the start error will say why).
	if got := TempParent(tmp, func(string) bool { return true }, env(nil), homeFn); got != tmp {
		t.Fatalf("all noexec: %s", got)
	}
}

func TestRunUsesFallbackParent(t *testing.T) {
	setup := makeSetup(t, "#!/bin/sh\nexit 0\n")
	tmp := os.TempDir()
	cache := filepath.Join(t.TempDir(), "cache")
	t.Setenv("XDG_CACHE_HOME", cache)
	var where string
	_, _ = Run(Options{Self: setup, NoExec: func(d string) bool { return d == tmp },
		Runner: startRecorder(func(exe string) { where = exe })})
	if !strings.HasPrefix(where, cache+string(filepath.Separator)) {
		t.Fatalf("app started from %s, want under %s", where, cache)
	}
}

type startRecorder func(exe string)

func (f startRecorder) Start(exe string, _, _ []string) (proc.Process, error) {
	f(exe)
	return nil, errors.New("recorded only")
}
