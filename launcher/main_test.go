package main

import (
	"strings"
	"testing"
)

func TestParseArgs(t *testing.T) {
	cases := []struct {
		in   []string
		mode mode
		pid  int
		plan string
		rest string
	}{
		{nil, modeLaunch, 0, "", ""},
		{[]string{"a.png", "--flag=x"}, modeLaunch, 0, "", "a.png|--flag=x"},
		{[]string{"--restart"}, modeRestart, 0, "", ""},
		{[]string{"--restart=4242", "--x"}, modeRestart, 4242, "", "--x"},
		{[]string{"--restart", "--pid=77"}, modeRestart, 77, "", ""},
		{[]string{"--uninstall"}, modeUninstall, 0, "", ""},
		{[]string{"--uninstall", "--moss-silent"}, modeUninstall, 0, "", "--moss-silent"},
		{[]string{"--finish-uninstall=C:\\T\\plan 1.json"}, modeFinishUninstall, 0, "C:\\T\\plan 1.json", ""},
		{[]string{"--finish-uninstall=/t/plan.json", "--moss-silent"}, modeFinishUninstall, 0, "/t/plan.json", "--moss-silent"},
		{[]string{"--moss-launched", "--restarted"}, modeLaunch, 0, "", "--moss-launched|--restarted"},
	}
	for _, c := range cases {
		inv, err := parseArgs(c.in)
		if err != nil || inv.mode != c.mode || inv.pid != c.pid || inv.plan != c.plan || strings.Join(inv.rest, "|") != c.rest {
			t.Errorf("parseArgs(%q) = %+v, %v", c.in, inv, err)
		}
	}
	for _, bad := range [][]string{{"--restart=0"}, {"--restart=x"}, {"--finish-uninstall"}, {"--finish-uninstall="}, {"--uninstall", "--restart"}, {"--pid=5"}, {"--restart", "--pid=x"}} {
		if _, err := parseArgs(bad); err == nil {
			t.Errorf("parseArgs(%q) should fail", bad)
		}
	}
}
