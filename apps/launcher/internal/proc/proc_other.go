//go:build !linux && !windows

package proc

import "errors"

// List is not implemented on this OS (the launcher ships for Windows and Linux only).
func List() ([]Info, error) { return nil, errors.New("process listing is not supported on this OS") }
