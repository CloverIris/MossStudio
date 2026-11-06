package stub

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/CloverIris/MossStudio/apps/launcher/internal/proc"
)

// The app here is a shell script, run for real.
func TestRunStartsAppWaitsAndCleansUp(t *testing.T) {
	logDir := t.TempDir()
	argsFile := filepath.Join(logDir, "args")
	script := `#!/bin/sh
for a in "$@"; do printf '%s\n' "$a"; done > "` + argsFile + `"
case "$1" in --moss-setup=*) dir="${1#--moss-setup=}";; esac
test -x "$dir/mossstudio" || exit 50
echo "root=$MOSSSTUDIO_ROOT" >> "` + argsFile + `"
sleep 0.3
touch "$dir/.ready"
sleep 0.3
exit 7
`
	setup := makeSetup(t, script)
	tmp := t.TempDir()
	t.Setenv("MOSSSTUDIO_ROOT", "/should/not/leak")
	splash := &recSplash{}
	start := time.Now()
	code, err := Run(Options{Self: setup, Args: []string{"--moss-silent", "--moss-install-to=/opt/装 这里"}, Splash: splash,
		Runner: proc.ExecRunner{}, TempDir: tmp, Poll: 20 * time.Millisecond})
	if err != nil || code != 7 {
		t.Fatalf("code %d err %v", code, err)
	}
	got, _ := os.ReadFile(argsFile)
	lines := strings.Split(strings.TrimSpace(string(got)), "\n")
	if len(lines) != 4 || !strings.HasPrefix(lines[0], "--moss-setup="+filepath.Join(tmp, "MossStudio-Setup-")) ||
		lines[1] != "--moss-silent" || lines[2] != "--moss-install-to=/opt/装 这里" || lines[3] != "root=" {
		t.Fatalf("app saw %q", lines)
	}
	if splash.last != splash.total || splash.total == 0 {
		t.Errorf("progress %d/%d", splash.last, splash.total)
	}
	if splash.closedAt.Sub(start) < 300*time.Millisecond || splash.closedAt.IsZero() {
		t.Errorf("splash closed too early or never (%v)", splash.closedAt.Sub(start))
	}
	if ents, _ := os.ReadDir(tmp); len(ents) != 0 {
		t.Errorf("temp dir not removed: %v", ents)
	}
}
