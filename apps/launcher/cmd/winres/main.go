// Command winres writes the launcher's Windows resource object (icon, version info,
// manifest) for the Go linker:
//
//	go run ./cmd/winres -ico <file.ico> -version <semver> -out rsrc_windows_amd64.syso
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/ShallowElec/MossStudio/apps/launcher/internal/winres"
)

func main() {
	ico := flag.String("ico", "", "icon file (.ico)")
	version := flag.String("version", "", "version (semver)")
	out := flag.String("out", "rsrc_windows_amd64.syso", "output .syso")
	flag.Parse()
	if *ico == "" || *version == "" {
		flag.Usage()
		os.Exit(2)
	}
	data, err := os.ReadFile(*ico)
	if err == nil {
		data, err = winres.Build(data, winres.Info{
			Version: *version, Company: "CloverIris", Product: "MossStudio", Description: "MossStudio",
			Copyright: "Copyright © CloverIris", FileName: "MossStudio.exe",
		})
	}
	if err == nil {
		err = os.WriteFile(*out, data, 0o644)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "winres:", err)
		os.Exit(1)
	}
}
