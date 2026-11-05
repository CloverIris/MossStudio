package main

// End-to-end tests: the real launcher binary, built for the host, with shell-script apps.

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/CloverIris/MossStudio/launcher/internal/payload"
	"github.com/CloverIris/MossStudio/launcher/internal/record"
)

// buildLauncher compiles this package for the host into dir.
func buildLauncher(t *testing.T, dir string) string {
	t.Helper()
	out := filepath.Join(dir, "moss-launcher")
	cmd := exec.Command("go", "build", "-trimpath", "-o", out, ".")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build: %v\n%s", err, b)
	}
	return out
}

func writeApp(t *testing.T, root, version, script string) {
	t.Helper()
	dir := filepath.Join(root, "app-"+version)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "MossStudio"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func copyFile(t *testing.T, from, to string) {
	t.Helper()
	b, err := os.ReadFile(from)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(to, b, 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestEndToEndSetupStub(t *testing.T) {
	work := t.TempDir()
	bin := buildLauncher(t, work)
	payloadDir := filepath.Join(work, "payload")
	marker := filepath.Join(work, "seen")
	writeApp(t, payloadDir, "3.1.0", `#!/bin/sh
dir="${1#--moss-setup=}"
cmp -s "$dir/mossstudio" "`+bin+`" && echo "launcher-ok $2" > "`+marker+`"
touch "$dir/.ready"
exit 5
`)
	setup := filepath.Join(work, "MossStudio-Setup-3.1.0-linux-x64.run")
	var stdout, stderr bytes.Buffer
	if code := runPack([]string{"--stub", bin, "--payload", payloadDir, "--out", setup, "--level", "1"}, &stdout, &stderr); code != 0 {
		t.Fatalf("pack: %d %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "version 3.1.0") {
		t.Errorf("pack output %q", stdout.String())
	}
	tmp := filepath.Join(work, "tmp")
	os.Mkdir(tmp, 0o755)
	cmd := exec.Command(setup, "--moss-silent")
	cmd.Env = append(os.Environ(), "TMPDIR="+tmp)
	err := cmd.Run()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 5 {
		t.Fatalf("setup exit: %v", err)
	}
	if b, _ := os.ReadFile(marker); strings.TrimSpace(string(b)) != "launcher-ok --moss-silent" {
		t.Fatalf("app saw %q", b)
	}
	if ents, _ := os.ReadDir(tmp); len(ents) != 0 {
		t.Fatalf("payload dir left behind: %v", ents)
	}
	// The plain launcher is not a setup file; packing a setup file as stub is refused.
	if payload.HasPayload(bin) {
		t.Fatal("plain launcher detected as setup")
	}
	if code := runPack([]string{"--stub", setup, "--payload", payloadDir, "--out", filepath.Join(work, "x")}, &stdout, &stderr); code == 0 {
		t.Fatal("packing a setup file as stub must fail")
	}
}

func writeRecord(t *testing.T, root string, mut func(m map[string]any)) {
	t.Helper()
	m := map[string]any{
		"schema": 1, "platform": "linux-x64", "root": root, "dataRoot": filepath.Join(root, "data"), "portable": false,
		"channel": "stable", "current": "1.0.0", "failed": []string{}, "confirmed": true,
		"installedAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z", "fromTheFuture": 42,
	}
	mut(m)
	b, _ := json.Marshal(m)
	if err := os.WriteFile(filepath.Join(root, "install.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func readRecord(t *testing.T, root string) *record.Record {
	t.Helper()
	r, err := record.Read(filepath.Join(root, "install.json"))
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// confirmScript is an app that confirms its health like the real one, then exits 0.
func confirmScript(log string) string {
	return `#!/bin/sh
echo "$(basename "$(dirname "$0")") $* root=$MOSSSTUDIO_ROOT launcher=$MOSSSTUDIO_LAUNCHER" >> "` + log + `"
f="$MOSSSTUDIO_ROOT/install.json"
sed 's/"confirmed": false/"confirmed": true/' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
exit 0
`
}

func TestEndToEndLaunchSwitchAndRollback(t *testing.T) {
	work := t.TempDir()
	bin := buildLauncher(t, work)
	root := filepath.Join(work, "Moss Studio 根")
	os.MkdirAll(filepath.Join(root, "data"), 0o755)
	launcher := filepath.Join(root, "mossstudio")
	copyFile(t, bin, launcher)
	log := filepath.Join(work, "log")
	writeApp(t, root, "1.0.0", confirmScript(log))
	writeApp(t, root, "1.1.0", "#!/bin/sh\necho \"app-1.1.0 crashed\" >> \""+log+"\"\nexit 3\n")
	writeApp(t, root, "0.9.0", "#!/bin/sh\nexit 0\n")
	writeRecord(t, root, func(m map[string]any) { m["pending"] = "1.1.0" })

	cmd := exec.Command(launcher, "打开 文件.png")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("launcher: %v\n%s", err, out)
	}
	b, _ := os.ReadFile(log)
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) != 2 || lines[0] != "app-1.1.0 crashed" ||
		lines[1] != "app-1.0.0 --moss-launched 打开 文件.png root="+root+" launcher="+launcher {
		t.Fatalf("app runs: %q", lines)
	}
	r := readRecord(t, root)
	if r.Current != "1.0.0" || !r.IsFailed("1.1.0") || r.Previous != "" || r.Pending != "" {
		t.Fatalf("record after rollback %+v", r)
	}
	if _, ok := r.Extra()["fromTheFuture"]; !ok {
		t.Error("unknown key lost")
	}
	if _, err := os.Stat(filepath.Join(root, "app-0.9.0")); !errors.Is(err, os.ErrNotExist) {
		t.Error("old app-0.9.0 should have been cleaned up")
	}
	if _, err := os.Stat(filepath.Join(root, "data", "logs", "launcher.log")); err != nil {
		t.Errorf("launcher log missing: %v", err)
	}

	// A good update: switch, confirm, keep the previous version.
	writeApp(t, root, "1.2.0", confirmScript(log))
	writeRecord(t, root, func(m map[string]any) { m["pending"] = "1.2.0"; m["failed"] = []string{"1.1.0"} })
	if out, err := exec.Command(launcher).CombinedOutput(); err != nil {
		t.Fatalf("launcher: %v\n%s", err, out)
	}
	r = readRecord(t, root)
	if r.Current != "1.2.0" || r.Previous != "1.0.0" || !r.Confirmed {
		t.Fatalf("record after update %+v", r)
	}
	if _, err := os.Stat(filepath.Join(root, "app-1.1.0")); !errors.Is(err, os.ErrNotExist) {
		t.Error("failed app-1.1.0 should have been cleaned up")
	}
}

func TestEndToEndRestartWaitsForPid(t *testing.T) {
	work := t.TempDir()
	bin := buildLauncher(t, work)
	root := filepath.Join(work, "R")
	launcher := filepath.Join(root, "mossstudio")
	os.MkdirAll(root, 0o755)
	copyFile(t, bin, launcher)
	log := filepath.Join(work, "log")
	writeApp(t, root, "1.0.0", confirmScript(log))
	writeApp(t, root, "2.0.0", confirmScript(log))
	writeRecord(t, root, func(m map[string]any) { m["pending"] = "2.0.0" })

	quitting := exec.Command("sleep", "1")
	if err := quitting.Start(); err != nil {
		t.Fatal(err)
	}
	go quitting.Wait()
	start := time.Now()
	out, err := exec.Command(launcher, "--restart", "--pid="+strconv.Itoa(quitting.Process.Pid)).CombinedOutput()
	if err != nil {
		t.Fatalf("restart: %v\n%s", err, out)
	}
	if time.Since(start) < 800*time.Millisecond {
		t.Fatal("restart did not wait for the quitting pid")
	}
	if r := readRecord(t, root); r.Current != "2.0.0" || r.Previous != "1.0.0" || !r.Confirmed {
		t.Fatalf("record %+v", r)
	}
}

func TestEndToEndMissingRecordFailsClearly(t *testing.T) {
	work := t.TempDir()
	bin := buildLauncher(t, work)
	root := filepath.Join(work, "R")
	os.MkdirAll(root, 0o755)
	launcher := filepath.Join(root, "mossstudio")
	copyFile(t, bin, launcher)
	cmd := exec.Command(launcher)
	cmd.Env = append(os.Environ(), "DISPLAY=", "WAYLAND_DISPLAY=")
	out, err := cmd.CombinedOutput()
	var ee *exec.ExitError
	if !errors.As(err, &ee) || ee.ExitCode() != 1 || !strings.Contains(string(out), "找不到安装记录") {
		t.Fatalf("got %v\n%s", err, out)
	}
}

func TestEndToEndFinishUninstall(t *testing.T) {
	work := t.TempDir()
	bin := buildLauncher(t, work)
	home := filepath.Join(work, "home")
	root := filepath.Join(home, ".local", "share", "MossStudio")
	data := filepath.Join(root, "data")
	apps := filepath.Join(home, ".local", "share", "applications")
	for _, d := range []string{filepath.Join(root, "app-1.0.0"), filepath.Join(data, "works"), apps} {
		os.MkdirAll(d, 0o755)
	}
	copyFile(t, bin, filepath.Join(root, "mossstudio"))
	os.WriteFile(filepath.Join(root, "app-1.0.0", "MossStudio"), []byte("x"), 0o755)
	writeRecord(t, root, func(m map[string]any) {})
	os.WriteFile(filepath.Join(data, "works", "keep.png"), []byte("x"), 0o644)
	desktop := filepath.Join(apps, "mossstudio.desktop")
	os.WriteFile(desktop, []byte("[Desktop Entry]"), 0o644)

	tmpDir := filepath.Join(work, "tmp", "MossStudio-uninstall-abc")
	os.MkdirAll(tmpDir, 0o755)
	copyLauncher := filepath.Join(tmpDir, "mossstudio")
	copyFile(t, bin, copyLauncher)
	plan := map[string]any{
		"schema": 1, "platform": "linux-x64", "root": root, "dataRoot": data, "removeData": false,
		"remove":          []string{filepath.Join(root, "app-1.0.0"), filepath.Join(root, "mossstudio"), filepath.Join(root, "install.json"), desktop},
		"registryKeys":    []string{},
		"removeEmptyDirs": []string{root},
		"createdAt":       "2026-11-05T00:00:00.000Z",
	}
	b, _ := json.Marshal(plan)
	planPath := filepath.Join(tmpDir, "plan.json")
	os.WriteFile(planPath, b, 0o644)

	cmd := exec.Command(copyLauncher, "--finish-uninstall="+planPath)
	cmd.Env = append(os.Environ(), "HOME="+home, "XDG_DATA_HOME=", "XDG_CONFIG_HOME=", "DISPLAY=", "WAYLAND_DISPLAY=")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("finish-uninstall: %v\n%s", err, out)
	}
	for _, gone := range []string{filepath.Join(root, "app-1.0.0"), filepath.Join(root, "mossstudio"), desktop, tmpDir} {
		if _, err := os.Lstat(gone); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s should be gone", gone)
		}
	}
	if _, err := os.Stat(filepath.Join(data, "works", "keep.png")); err != nil {
		t.Error("data must be kept when not listed")
	}

	// A plan reaching outside R is refused and deletes nothing.
	os.MkdirAll(tmpDir, 0o755)
	copyFile(t, bin, copyLauncher)
	plan["remove"] = []string{filepath.Join(home, ".bashrc")}
	os.WriteFile(filepath.Join(home, ".bashrc"), []byte("x"), 0o644)
	b, _ = json.Marshal(plan)
	os.WriteFile(planPath, b, 0o644)
	cmd = exec.Command(copyLauncher, "--finish-uninstall="+planPath)
	cmd.Env = append(os.Environ(), "HOME="+home, "XDG_DATA_HOME=", "XDG_CONFIG_HOME=", "DISPLAY=", "WAYLAND_DISPLAY=")
	if err := cmd.Run(); err == nil {
		t.Fatal("bad plan must fail")
	}
	if _, err := os.Stat(filepath.Join(home, ".bashrc")); err != nil {
		t.Fatal("refused plan deleted a file")
	}
}

// TestEndToEndFinishUninstallSilentShowsNoDialog: a refused plan shows the zenity dialog
// normally, and with --moss-silent only writes stderr and exits 1 (nothing to click on a
// headless or unattended run).
func TestEndToEndFinishUninstallSilentShowsNoDialog(t *testing.T) {
	work := t.TempDir()
	bin := buildLauncher(t, work)
	fakeBin := filepath.Join(work, "bin")
	os.MkdirAll(fakeBin, 0o755)
	marker := filepath.Join(work, "zenity-ran")
	os.WriteFile(filepath.Join(fakeBin, "zenity"), []byte("#!/bin/sh\ntouch \""+marker+"\"\n"), 0o755)
	tmpDir := filepath.Join(work, "tmp", "MossStudio-uninstall-s")
	os.MkdirAll(tmpDir, 0o755)
	copyLauncher := filepath.Join(tmpDir, "mossstudio")
	copyFile(t, bin, copyLauncher)
	planPath := filepath.Join(tmpDir, "plan.json")
	os.WriteFile(planPath, []byte(`{"schema":1,"platform":"linux-x64","root":"/etc","dataRoot":"/etc/data","removeData":false,"remove":[],"createdAt":"x"}`), 0o644)
	run := func(extra ...string) (int, string) {
		cmd := exec.Command(copyLauncher, append([]string{"--finish-uninstall=" + planPath}, extra...)...)
		cmd.Env = append(os.Environ(), "PATH="+fakeBin+":/usr/bin:/bin", "DISPLAY=:99", "WAYLAND_DISPLAY=")
		out, err := cmd.CombinedOutput()
		var ee *exec.ExitError
		if !errors.As(err, &ee) {
			t.Fatalf("expected a non-zero exit, got %v\n%s", err, out)
		}
		return ee.ExitCode(), string(out)
	}
	code, out := run("--moss-silent")
	if code != 1 || !strings.Contains(out, "卸载计划无效") {
		t.Fatalf("silent: code %d\n%s", code, out)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("--moss-silent must not show a dialog")
	}
	if _, err := os.Stat(planPath); err != nil {
		t.Fatal("a refused plan must leave the plan and the copy in place")
	}
	if code, _ := run(); code != 1 {
		t.Fatalf("interactive: code %d", code)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("without --moss-silent the dialog is shown")
	}
}
