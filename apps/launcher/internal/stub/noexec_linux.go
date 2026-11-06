package stub

import "syscall"

// stNoExec is ST_NOEXEC in statfs(2) f_flags.
const stNoExec = 0x8

// mountedNoExec reports whether dir is on a filesystem mounted noexec.
func mountedNoExec(dir string) bool {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return false
	}
	return st.Flags&stNoExec != 0
}
