//go:build !windows

package uninstall

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/CloverIris/MossStudio/launcher/internal/proc"
)

func TestValidateRefusesSymlinkEscape(t *testing.T) {
	w := newWorld(t)
	victim := filepath.Join(w.home, "Documents")
	mustT(t, os.MkdirAll(victim, 0o755))
	mustT(t, os.WriteFile(filepath.Join(victim, "thesis.docx"), []byte("precious"), 0o644))
	link := filepath.Join(w.root, "app-9.9.9") // an owned name, but a symlink out of R
	mustT(t, os.Symlink(victim, link))
	p := w.plan(false)
	p.Remove = append(p.Remove, filepath.Join(link, "thesis.docx"))
	if err := w.checker().Validate(p); err == nil {
		t.Fatal("path through a symlink out of R must be refused")
	}
	// The link itself may be listed: removing it removes the link, not the target.
	p = w.plan(false)
	p.Remove = append(p.Remove, link)
	mustT(t, w.checker().Validate(p))
	r, _ := runner(func() []proc.Info { return nil })
	mustT(t, r.Execute(p))
	if _, err := os.Stat(filepath.Join(victim, "thesis.docx")); err != nil {
		t.Fatal("symlink target was deleted")
	}
	if _, err := os.Lstat(link); !os.IsNotExist(err) {
		t.Fatal("link should be gone")
	}
}
