package stub

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ShallowElec/MossStudio/apps/launcher/internal/launch"
	"github.com/ShallowElec/MossStudio/apps/launcher/internal/proc"
)

// An app that dies before its window is up showed nothing: the stub says so and names the log.
// After the window was up (or on a clean exit) the app has spoken for itself.
func TestRunReportsAnAppThatEndsBeforeShowingAnything(t *testing.T) {
	cases := []struct {
		name, script string
		code         int
		reported     bool
	}{
		{"crash before ready", "#!/bin/sh\nexit 3\n", 3, true},
		{"clean exit before ready", "#!/bin/sh\nexit 0\n", 0, false},
		{"failure after ready", "#!/bin/sh\ncase \"$1\" in --moss-setup=*) touch \"${1#--moss-setup=}/.ready\";; esac\nexit 4\n", 4, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			setup := makeSetup(t, c.script)
			code, err := Run(Options{Self: setup, Runner: proc.ExecRunner{}, TempDir: t.TempDir(), Poll: 10 * time.Millisecond,
				LogPath: "/tmp/日志/MossStudio-setup.log"})
			if code != c.code {
				t.Fatalf("code %d, want %d", code, c.code)
			}
			var le *launch.Error
			if !c.reported {
				if err != nil {
					t.Fatalf("unexpected error %v", err)
				}
				return
			}
			if !errors.As(err, &le) || !strings.Contains(le.Message, "没能打开") ||
				!strings.Contains(le.Detail, "/tmp/日志/MossStudio-setup.log") || !strings.Contains(le.Detail, "退出码 3") {
				t.Fatalf("err %#v", err)
			}
		})
	}
}

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
