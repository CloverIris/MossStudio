// Package ui is the launcher's only user interface: the setup stub's splash window and
// error messages. Windows uses Win32 directly (splash_windows.go); elsewhere the splash is
// a progress line on a terminal and errors go to zenity when available, and to stderr.
package ui

// Splash shows extraction progress until closed. Methods are safe from any goroutine and
// Close may be called more than once.
type Splash interface {
	SetProgress(done, total int64)
	Close()
}

type noSplash struct{}

func (noSplash) SetProgress(int64, int64) {}
func (noSplash) Close()                   {}

// NoSplash is a Splash that shows nothing (silent installs).
var NoSplash Splash = noSplash{}

// Text shown on the splash.
const SplashText = "正在准备安装…"

// Colours follow the app's tokens (styles.css): surface, ink, ink-2, well over surface, accent.
type palette struct{ bg, ink, ink2, track, accent uint32 }

// rgb packs a colour as 0xRRGGBB.
var (
	lightPalette = palette{bg: 0xf7f7f5, ink: 0x1c1c1e, ink2: 0x5e5e5a, track: 0xeaeae8, accent: 0xe8571a}
	darkPalette  = palette{bg: 0x1c1c1f, ink: 0xededea, ink2: 0xa2a29d, track: 0x2a2a2c, accent: 0xff6b2c}
)

// fraction turns done/total into 0..1000.
func fraction(done, total int64) int {
	if total <= 0 || done <= 0 {
		return 0
	}
	if done >= total {
		return 1000
	}
	return int(done * 1000 / total)
}
