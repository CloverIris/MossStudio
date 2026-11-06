package proc

import (
	"os"
	"path/filepath"
	"testing"
)

func fakeSysctl(t *testing.T, values map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for name, value := range values {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestSandboxArgs(t *testing.T) {
	app := t.TempDir()
	exe := filepath.Join(app, "mossstudio")
	// A chrome-sandbox the user owns, as every per-user install has: not usable.
	if err := os.WriteFile(filepath.Join(app, "chrome-sandbox"), nil, 0o755); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		sysctl map[string]string
		want   bool
	}{
		{"namespaces allowed", map[string]string{"kernel/apparmor_restrict_unprivileged_userns": "0", "user/max_user_namespaces": "63000"}, false},
		{"no switches at all", nil, false},
		{"Ubuntu AppArmor restriction", map[string]string{"kernel/apparmor_restrict_unprivileged_userns": "1"}, true},
		{"Debian unprivileged_userns_clone=0", map[string]string{"kernel/unprivileged_userns_clone": "0"}, true},
		{"max_user_namespaces=0", map[string]string{"user/max_user_namespaces": "0"}, true},
	}
	saved := sandboxRoot
	t.Cleanup(func() { sandboxRoot = saved })
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sandboxRoot = fakeSysctl(t, c.sysctl)
			got := sandboxArgs(exe)
			if (len(got) == 1 && got[0] == "--no-sandbox") != c.want || (!c.want && len(got) != 0) {
				t.Fatalf("sandboxArgs = %v, want no-sandbox=%v", got, c.want)
			}
		})
	}
}
