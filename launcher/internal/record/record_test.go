package record

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const sample = `{
  "schema": 1,
  "platform": "win32-x64",
  "root": "C:\\Users\\张三\\AppData\\Local\\Programs\\MossStudio",
  "dataRoot": "C:\\Users\\张三\\AppData\\Local\\Programs\\MossStudio\\data",
  "portable": false,
  "channel": "stable",
  "current": "1.2.0",
  "previous": "1.1.0",
  "failed": ["1.1.5"],
  "confirmed": true,
  "installedAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-02T00:00:00.000Z",
  "futureKey": {"nested": [1, 2, "<&>"]},
  "anotherKey": "x"
}`

func TestParseValid(t *testing.T) {
	r, err := Parse([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	if r.Current != "1.2.0" || r.Previous != "1.1.0" || r.Pending != "" || !r.Confirmed || r.Platform != "win32-x64" {
		t.Fatalf("unexpected record %+v", r)
	}
	if !r.IsFailed("1.1.5") || r.IsFailed("1.2.0") {
		t.Fatal("failed list wrong")
	}
	if len(r.Extra()) != 2 {
		t.Fatalf("extra = %v", r.Extra())
	}
}

func TestParseBOMAndDefaultFailed(t *testing.T) {
	in := strings.Replace(sample, `"failed": ["1.1.5"],`, "", 1)
	r, err := Parse(append([]byte("\xef\xbb\xbf"), in...))
	if err != nil {
		t.Fatal(err)
	}
	if r.Failed == nil || len(r.Failed) != 0 {
		t.Fatalf("failed should default to [], got %#v", r.Failed)
	}
}

func TestParseRejects(t *testing.T) {
	cases := map[string]string{
		"not json":       `{`,
		"array":          `[]`,
		"null":           `null`,
		"schema 2":       strings.Replace(sample, `"schema": 1`, `"schema": 2`, 1),
		"bad platform":   strings.Replace(sample, `"win32-x64"`, `"win32-arm64"`, 1),
		"bad channel":    strings.Replace(sample, `"stable"`, `"nightly"`, 1),
		"bad current":    strings.Replace(sample, `"current": "1.2.0"`, `"current": "1.2"`, 1),
		"null previous":  strings.Replace(sample, `"previous": "1.1.0"`, `"previous": null`, 1),
		"missing root":   strings.Replace(sample, `"root": "C:\\Users\\张三\\AppData\\Local\\Programs\\MossStudio",`, "", 1),
		"empty dataRoot": strings.Replace(sample, `"dataRoot": "C:\\Users\\张三\\AppData\\Local\\Programs\\MossStudio\\data"`, `"dataRoot": ""`, 1),
		"string bool":    strings.Replace(sample, `"confirmed": true`, `"confirmed": "true"`, 1),
		"bad failed":     strings.Replace(sample, `["1.1.5"]`, `["x"]`, 1),
		"failed null":    strings.Replace(sample, `["1.1.5"]`, `null`, 1),
	}
	for name, in := range cases {
		if in == sample {
			t.Fatalf("%s: replacement did not apply", name)
		}
		if _, err := Parse([]byte(in)); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestRoundTripKeepsUnknownKeys(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, FileName)
	if err := os.WriteFile(path, []byte(sample), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := Read(path)
	if err != nil {
		t.Fatal(err)
	}
	r.Pending = "1.3.0"
	r.Previous = ""
	r.Touch(time.Date(2026, 3, 4, 5, 6, 7, 8_000_000, time.UTC))
	if err := Write(path, r); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	if _, ok := m["previous"]; ok {
		t.Error("unset previous must be omitted, not null")
	}
	if m["pending"] != "1.3.0" || m["updatedAt"] != "2026-03-04T05:06:07.008Z" {
		t.Errorf("fields not written: %v", m)
	}
	if m["anotherKey"] != "x" {
		t.Error("unknown string key lost")
	}
	nested, _ := m["futureKey"].(map[string]any)
	if nested == nil || len(nested["nested"].([]any)) != 3 {
		t.Errorf("unknown object key lost: %v", m["futureKey"])
	}
	if strings.Contains(string(data), `\u003c`) {
		t.Error("output must not HTML-escape")
	}
	if !strings.HasSuffix(string(data), "}\n") || !strings.HasPrefix(string(data), "{\n  \"schema\": 1,\n  \"platform\"") {
		t.Errorf("unexpected layout:\n%s", data)
	}
	// Re-read: still valid, same values.
	r2, err := Read(path)
	if err != nil {
		t.Fatal(err)
	}
	if r2.Pending != "1.3.0" || r2.Root != r.Root || len(r2.Extra()) != 2 {
		t.Fatalf("round trip mismatch %+v", r2)
	}
	// No temp files left behind.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("leftover files: %v", entries)
	}
}

func TestReadMissingAndCorrupt(t *testing.T) {
	dir := t.TempDir()
	_, err := Read(filepath.Join(dir, FileName))
	if !errors.Is(err, ErrMissing) {
		t.Fatalf("want ErrMissing, got %v", err)
	}
	path := filepath.Join(dir, FileName)
	os.WriteFile(path, []byte(`{"schema":1}`), 0o644)
	_, err = Read(path)
	var ce *CorruptError
	if !errors.As(err, &ce) || !strings.Contains(ce.Error(), "current: required") {
		t.Fatalf("want CorruptError naming the field, got %v", err)
	}
}

func TestMarkFailedDedupes(t *testing.T) {
	r := &Record{}
	r.MarkFailed("1.0.0")
	r.MarkFailed("1.0.0")
	r.MarkFailed("")
	if len(r.Failed) != 1 {
		t.Fatal(r.Failed)
	}
}
