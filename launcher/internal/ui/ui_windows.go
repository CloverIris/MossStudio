package ui

import (
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

// Win32 entry points, all from system DLLs (no cgo). Optional ones are checked with Find.
var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	dwmapi   = syscall.NewLazyDLL("dwmapi.dll")

	pRegisterClassExW              = user32.NewProc("RegisterClassExW")
	pCreateWindowExW               = user32.NewProc("CreateWindowExW")
	pDefWindowProcW                = user32.NewProc("DefWindowProcW")
	pDestroyWindow                 = user32.NewProc("DestroyWindow")
	pShowWindow                    = user32.NewProc("ShowWindow")
	pUpdateWindow                  = user32.NewProc("UpdateWindow")
	pGetMessageW                   = user32.NewProc("GetMessageW")
	pTranslateMessage              = user32.NewProc("TranslateMessage")
	pDispatchMessageW              = user32.NewProc("DispatchMessageW")
	pPostMessageW                  = user32.NewProc("PostMessageW")
	pPostQuitMessage               = user32.NewProc("PostQuitMessage")
	pBeginPaint                    = user32.NewProc("BeginPaint")
	pEndPaint                      = user32.NewProc("EndPaint")
	pInvalidateRect                = user32.NewProc("InvalidateRect")
	pGetClientRect                 = user32.NewProc("GetClientRect")
	pFillRect                      = user32.NewProc("FillRect")
	pDrawTextW                     = user32.NewProc("DrawTextW")
	pLoadImageW                    = user32.NewProc("LoadImageW")
	pLoadCursorW                   = user32.NewProc("LoadCursorW")
	pDrawIconEx                    = user32.NewProc("DrawIconEx")
	pSystemParametersInfoW         = user32.NewProc("SystemParametersInfoW")
	pSetForegroundWindow           = user32.NewProc("SetForegroundWindow")
	pMessageBoxW                   = user32.NewProc("MessageBoxW")
	pGetDpiForSystem               = user32.NewProc("GetDpiForSystem")
	pSetProcessDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
	pCreateSolidBrush              = gdi32.NewProc("CreateSolidBrush")
	pDeleteObject                  = gdi32.NewProc("DeleteObject")
	pCreateFontW                   = gdi32.NewProc("CreateFontW")
	pSelectObject                  = gdi32.NewProc("SelectObject")
	pSetTextColor                  = gdi32.NewProc("SetTextColor")
	pSetBkMode                     = gdi32.NewProc("SetBkMode")
	pCreateCompatibleDC            = gdi32.NewProc("CreateCompatibleDC")
	pCreateCompatibleBitmap        = gdi32.NewProc("CreateCompatibleBitmap")
	pBitBlt                        = gdi32.NewProc("BitBlt")
	pDeleteDC                      = gdi32.NewProc("DeleteDC")
	pGetModuleHandleW              = kernel32.NewProc("GetModuleHandleW")
	pDwmSetWindowAttribute         = dwmapi.NewProc("DwmSetWindowAttribute")
)

const (
	wsPopup          = 0x80000000
	wsExAppWindow    = 0x00040000
	wsExTopmost      = 0x00000008
	csDropShadow     = 0x00020000
	swShow           = 5
	wmDestroy        = 0x0002
	wmPaint          = 0x000F
	wmClose          = 0x0010
	wmEraseBkgnd     = 0x0014
	wmNCHitTest      = 0x0084
	wmApp            = 0x8000
	wmProgress       = wmApp + 1
	htCaption        = 2
	imageIcon        = 1
	lrDefaultColor   = 0
	lrShared         = 0x8000
	idcArrow         = 32512
	spiGetWorkArea   = 0x0030
	transparent      = 1
	srcCopy          = 0x00CC0020
	dtLeft           = 0x0000
	dtVCenter        = 0x0004
	dtSingleLine     = 0x0020
	dtEndEllipsis    = 0x8000
	diNormal         = 0x0003
	mbOK             = 0x0000
	mbIconError      = 0x0010
	mbSetForeground  = 0x00010000
	dwmwaCornerPref  = 33
	dwmwcpRound      = 2
	fwNormal         = 400
	fwSemibold       = 600
	defaultCharset   = 1
	cleartypeQuality = 5
)

type rect struct{ Left, Top, Right, Bottom int32 }

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   uintptr
	Icon       uintptr
	Cursor     uintptr
	Background uintptr
	MenuName   *uint16
	ClassName  *uint16
	IconSm     uintptr
}

type msg struct {
	Hwnd    uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      struct{ X, Y int32 }
	Private uint32
}

type paintStruct struct {
	Hdc        uintptr
	Erase      int32
	Paint      rect
	Restore    int32
	IncUpdate  int32
	Reserved   [32]byte
	_alignment [4]byte
}

func utf16p(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }

// colorref turns 0xRRGGBB into a Win32 COLORREF (0x00BBGGRR).
func colorref(rgb uint32) uintptr {
	return uintptr((rgb>>16)&0xff | (rgb & 0xff00) | (rgb&0xff)<<16)
}

// lightTheme reads HKCU\...\Themes\Personalize\AppsUseLightTheme (default light).
func lightTheme() bool {
	var key syscall.Handle
	if syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, utf16p(`Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`), 0, syscall.KEY_READ, &key) != nil {
		return true
	}
	defer syscall.RegCloseKey(key)
	var v, typ uint32
	n := uint32(4)
	if syscall.RegQueryValueEx(key, utf16p("AppsUseLightTheme"), nil, &typ, (*byte)(unsafe.Pointer(&v)), &n) != nil || typ != syscall.REG_DWORD {
		return true
	}
	return v != 0
}

func dpiScale() float64 {
	if pSetProcessDpiAwarenessContext.Find() == nil {
		pSetProcessDpiAwarenessContext.Call(^uintptr(3)) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4)
	}
	if pGetDpiForSystem.Find() == nil {
		if dpi, _, _ := pGetDpiForSystem.Call(); dpi > 0 {
			return float64(dpi) / 96
		}
	}
	return 1
}

type winSplash struct {
	mu     sync.Mutex
	hwnd   uintptr
	closed bool

	// Owned by the window thread.
	scale    float64
	pal      palette
	progress int
	icon     uintptr
	font     uintptr
	title    uintptr
}

// ShowSplash opens the splash window on its own OS thread and returns once it is visible.
func ShowSplash() Splash {
	s := &winSplash{}
	ready := make(chan bool)
	go s.loop(ready)
	if !<-ready {
		return NoSplash
	}
	return s
}

func (s *winSplash) px(v float64) int32 { return int32(v*s.scale + 0.5) }

func (s *winSplash) loop(ready chan<- bool) {
	runtime.LockOSThread()
	s.scale = dpiScale()
	s.pal = lightPalette
	if !lightTheme() {
		s.pal = darkPalette
	}
	inst, _, _ := pGetModuleHandleW.Call(0)
	s.icon, _, _ = pLoadImageW.Call(inst, 1, imageIcon, uintptr(s.px(48)), uintptr(s.px(48)), lrDefaultColor)
	smallIcon, _, _ := pLoadImageW.Call(inst, 1, imageIcon, uintptr(s.px(16)), uintptr(s.px(16)), lrDefaultColor)
	cursor, _, _ := pLoadCursorW.Call(0, idcArrow)
	face := uintptr(unsafe.Pointer(utf16p("Microsoft YaHei UI")))
	s.font, _, _ = pCreateFontW.Call(uintptr(-s.px(14)), 0, 0, 0, fwNormal, 0, 0, 0, defaultCharset, 0, 0, cleartypeQuality, 0, face)
	s.title, _, _ = pCreateFontW.Call(uintptr(-s.px(16)), 0, 0, 0, fwSemibold, 0, 0, 0, defaultCharset, 0, 0, cleartypeQuality, 0, face)

	className := utf16p("MossStudioSetupSplash")
	wc := wndClassEx{
		Style: csDropShadow, WndProc: syscall.NewCallback(s.wndProc), Instance: inst,
		Icon: s.icon, IconSm: smallIcon, Cursor: cursor, ClassName: className,
	}
	wc.Size = uint32(unsafe.Sizeof(wc))
	if r, _, _ := pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); r == 0 {
		ready <- false
		return
	}
	w, h := s.px(360), s.px(168)
	var work rect
	pSystemParametersInfoW.Call(spiGetWorkArea, 0, uintptr(unsafe.Pointer(&work)), 0)
	x := work.Left + (work.Right-work.Left-w)/2
	y := work.Top + (work.Bottom-work.Top-h)/2
	hwnd, _, _ := pCreateWindowExW.Call(wsExAppWindow|wsExTopmost, uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(utf16p("MossStudio"))), wsPopup,
		uintptr(x), uintptr(y), uintptr(w), uintptr(h), 0, 0, inst, 0)
	if hwnd == 0 {
		ready <- false
		return
	}
	if pDwmSetWindowAttribute.Find() == nil {
		pref := uint32(dwmwcpRound)
		pDwmSetWindowAttribute.Call(hwnd, dwmwaCornerPref, uintptr(unsafe.Pointer(&pref)), 4)
	}
	s.mu.Lock()
	s.hwnd = hwnd
	closed := s.closed
	s.mu.Unlock()
	pShowWindow.Call(hwnd, swShow)
	pUpdateWindow.Call(hwnd)
	pSetForegroundWindow.Call(hwnd)
	ready <- true
	if closed {
		pPostMessageW.Call(hwnd, wmClose, 0, 0)
	}
	var m msg
	for {
		r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		pTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		pDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	for _, o := range []uintptr{s.font, s.title} {
		pDeleteObject.Call(o)
	}
}

func (s *winSplash) wndProc(hwnd, message, wparam, lparam uintptr) uintptr {
	switch message {
	case wmProgress:
		if p := int(wparam); p != s.progress {
			s.progress = p
			pInvalidateRect.Call(hwnd, 0, 0)
		}
		return 0
	case wmEraseBkgnd:
		return 1
	case wmNCHitTest:
		return htCaption // drag anywhere
	case wmPaint:
		s.paint(hwnd)
		return 0
	case wmClose:
		pDestroyWindow.Call(hwnd)
		return 0
	case wmDestroy:
		pPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := pDefWindowProcW.Call(hwnd, message, wparam, lparam)
	return r
}

func (s *winSplash) fill(dc uintptr, r rect, rgb uint32) {
	br, _, _ := pCreateSolidBrush.Call(colorref(rgb))
	pFillRect.Call(dc, uintptr(unsafe.Pointer(&r)), br)
	pDeleteObject.Call(br)
}

func (s *winSplash) text(dc uintptr, font uintptr, rgb uint32, str string, r rect) {
	old, _, _ := pSelectObject.Call(dc, font)
	pSetTextColor.Call(dc, colorref(rgb))
	u, _ := syscall.UTF16FromString(str)
	pDrawTextW.Call(dc, uintptr(unsafe.Pointer(&u[0])), uintptr(len(u)-1), uintptr(unsafe.Pointer(&r)), dtLeft|dtVCenter|dtSingleLine|dtEndEllipsis)
	pSelectObject.Call(dc, old)
}

// paint draws, double-buffered: icon and name on the left, the status line, then a thin bar.
//
//	32px margin · 48px icon · 16px gap · "MossStudio"
//	status text 14px · 3px progress bar at the bottom margin
func (s *winSplash) paint(hwnd uintptr) {
	var ps paintStruct
	hdc, _, _ := pBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	defer pEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
	var cr rect
	pGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&cr)))
	mem, _, _ := pCreateCompatibleDC.Call(hdc)
	bmp, _, _ := pCreateCompatibleBitmap.Call(hdc, uintptr(cr.Right), uintptr(cr.Bottom))
	oldBmp, _, _ := pSelectObject.Call(mem, bmp)
	pSetBkMode.Call(mem, transparent)

	m := s.px(32)
	s.fill(mem, cr, s.pal.bg)
	if s.icon != 0 {
		pDrawIconEx.Call(mem, uintptr(m), uintptr(m), s.icon, uintptr(s.px(48)), uintptr(s.px(48)), 0, 0, diNormal)
	}
	s.text(mem, s.title, s.pal.ink, "MossStudio", rect{m + s.px(64), m, cr.Right - m, m + s.px(48)})
	barY := cr.Bottom - m
	s.text(mem, s.font, s.pal.ink2, SplashText, rect{m, barY - s.px(36), cr.Right - m, barY - s.px(12)})
	track := rect{m, barY, cr.Right - m, barY + s.px(3)}
	s.fill(mem, track, s.pal.track)
	if s.progress > 0 {
		done := track
		done.Right = track.Left + int32(int64(track.Right-track.Left)*int64(s.progress)/1000)
		s.fill(mem, done, s.pal.accent)
	}

	pBitBlt.Call(hdc, 0, 0, uintptr(cr.Right), uintptr(cr.Bottom), mem, 0, 0, srcCopy)
	pSelectObject.Call(mem, oldBmp)
	pDeleteObject.Call(bmp)
	pDeleteDC.Call(mem)
}

func (s *winSplash) SetProgress(done, total int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hwnd != 0 && !s.closed {
		pPostMessageW.Call(s.hwnd, wmProgress, uintptr(fraction(done, total)), 0)
	}
}

func (s *winSplash) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	if s.hwnd != 0 {
		pPostMessageW.Call(s.hwnd, wmClose, 0, 0)
	}
}

// Error shows a modal error box.
func Error(title, message, detail string) {
	text := message
	if detail != "" {
		text += "\n\n" + detail
	}
	pMessageBoxW.Call(0, uintptr(unsafe.Pointer(utf16p(text))), uintptr(unsafe.Pointer(utf16p(title))), mbOK|mbIconError|mbSetForeground)
}
