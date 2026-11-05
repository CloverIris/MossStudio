//go:build !linux

package stub

// mountedNoExec is Linux-only; elsewhere the system temp folder is used as is.
func mountedNoExec(string) bool { return false }
