package proc

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// sandboxRoot is where the kernel switches are read; tests point it at a fake /proc/sys.
var sandboxRoot = "/proc/sys"

// sandboxArgs returns --no-sandbox when Chromium has no usable sandbox here, which would
// otherwise make it abort at startup before MossStudio shows anything:
//
//   - its user-namespace sandbox needs unprivileged user namespaces, which Ubuntu 23.10+
//     (AppArmor, kernel.apparmor_restrict_unprivileged_userns=1), older Debian
//     (kernel.unprivileged_userns_clone=0) and hardened kernels (user.max_user_namespaces=0)
//     turn off; and
//   - its fallback, the chrome-sandbox helper next to the app, only works when root owns it
//     with the setuid bit, which an install into the user's own folder can never give it.
//
// When either sandbox can work, nothing is added.
func sandboxArgs(exe string) []string {
	if userNamespacesUsable(sandboxRoot) || setuidHelperUsable(filepath.Join(filepath.Dir(exe), "chrome-sandbox")) {
		return nil
	}
	return []string{"--no-sandbox"}
}

func userNamespacesUsable(root string) bool {
	read := func(name string) string {
		b, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			return ""
		}
		return strings.TrimSpace(string(b))
	}
	if read("kernel/apparmor_restrict_unprivileged_userns") == "1" {
		return false
	}
	if read("kernel/unprivileged_userns_clone") == "0" {
		return false
	}
	if read("user/max_user_namespaces") == "0" {
		return false
	}
	return true
}

func setuidHelperUsable(helper string) bool {
	info, err := os.Stat(helper)
	if err != nil {
		return false
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && st.Uid == 0 && info.Mode()&os.ModeSetuid != 0
}
