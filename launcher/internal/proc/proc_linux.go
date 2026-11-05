package proc

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// List returns the processes whose executable path can be read (this user's processes).
func List() ([]Info, error) {
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	var out []Info
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		exe, err := os.Readlink(filepath.Join("/proc", e.Name(), "exe"))
		if err != nil {
			continue
		}
		out = append(out, Info{Pid: pid, Exe: strings.TrimSuffix(exe, " (deleted)")})
	}
	return out, nil
}
