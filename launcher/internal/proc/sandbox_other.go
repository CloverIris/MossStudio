//go:build !linux

package proc

// sandboxArgs: Chromium's sandbox needs no help outside Linux.
func sandboxArgs(string) []string { return nil }
