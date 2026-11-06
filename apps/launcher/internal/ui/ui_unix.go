//go:build !windows

package ui

import (
	"fmt"
	"os"
	"os/exec"
	"sync"
)

func isTerminal(f *os.File) bool {
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

type ttySplash struct {
	mu     sync.Mutex
	last   int
	closed bool
}

// ShowSplash prints progress to stderr when it is a terminal; otherwise it shows nothing.
func ShowSplash() Splash {
	if !isTerminal(os.Stderr) {
		return NoSplash
	}
	s := &ttySplash{last: -1}
	fmt.Fprintf(os.Stderr, "%s", SplashText)
	return s
}

func (s *ttySplash) SetProgress(done, total int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	pct := fraction(done, total) / 10
	if s.closed || pct == s.last {
		return
	}
	s.last = pct
	fmt.Fprintf(os.Stderr, "\r%s %3d%%", SplashText, pct)
}

func (s *ttySplash) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		s.closed = true
		fmt.Fprintln(os.Stderr)
	}
}

// Error reports a failure: always on stderr, and in a zenity dialog when a desktop session
// is available (the launcher usually starts from a .desktop entry with no terminal).
func Error(title, message, detail string) {
	text := message
	if detail != "" {
		text += "\n\n" + detail
	}
	fmt.Fprintf(os.Stderr, "%s: %s\n", title, text)
	if os.Getenv("DISPLAY") == "" && os.Getenv("WAYLAND_DISPLAY") == "" {
		return
	}
	if zenity, err := exec.LookPath("zenity"); err == nil {
		exec.Command(zenity, "--error", "--no-markup", "--title", title, "--text", text).Run()
	}
}
