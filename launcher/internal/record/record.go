// Package record reads and writes R/install.json, the InstallRecord shared with the app.
//
// The shape mirrors installRecordSchema in apps/desktop/src/shared/install.ts exactly:
//
//	{
//	  "schema": 1,
//	  "platform": "win32-x64" | "linux-x64" | "darwin-arm64" | "darwin-x64",
//	  "root": "<abs>",
//	  "appPath": "<abs>",            // optional (macOS only)
//	  "dataRoot": "<abs>",
//	  "portable": false,
//	  "channel": "stable" | "beta",
//	  "current": "<semver>",
//	  "previous": "<semver>",        // optional
//	  "pending": "<semver>",         // optional
//	  "failed": ["<semver>", ...],   // defaults to []
//	  "confirmed": false,
//	  "installedAt": "<string>",
//	  "updatedAt": "<string>"
//	}
//
// Unknown keys are kept: Read remembers them and Write emits them after the known keys, so a
// newer app can add fields without the launcher dropping them. Optional fields are omitted
// (never null) when unset, as zod's .optional() rejects null.
package record

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	"github.com/CloverIris/MossStudio/launcher/internal/fsutil"
)

// FileName is the record's name inside the install root.
const FileName = "install.json"

var (
	semverRe  = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$`)
	platforms = map[string]bool{"win32-x64": true, "linux-x64": true, "darwin-arm64": true, "darwin-x64": true}
	channels  = map[string]bool{"stable": true, "beta": true}
)

// knownKeys lists the schema's keys in schema order; Write emits them in this order.
var knownKeys = []string{
	"schema", "platform", "root", "appPath", "dataRoot", "portable", "channel",
	"current", "previous", "pending", "failed", "confirmed", "installedAt", "updatedAt",
}

// Record is the typed view of install.json. Empty strings mean "unset" for the optional
// fields AppPath, Previous and Pending.
type Record struct {
	Schema      int
	Platform    string
	Root        string
	AppPath     string
	DataRoot    string
	Portable    bool
	Channel     string
	Current     string
	Previous    string
	Pending     string
	Failed      []string
	Confirmed   bool
	InstalledAt string
	UpdatedAt   string

	// extra holds keys this version does not know, verbatim.
	extra map[string]json.RawMessage
}

// IsSemver reports whether v matches the contract's semver pattern.
func IsSemver(v string) bool { return semverRe.MatchString(v) }

// ErrMissing is returned (wrapped) by Read when install.json does not exist.
var ErrMissing = errors.New("install.json is missing")

// CorruptError says install.json exists but is not a valid InstallRecord.
type CorruptError struct {
	Path   string
	Reason string
}

func (e *CorruptError) Error() string {
	return fmt.Sprintf("%s is not a valid install record: %s", e.Path, e.Reason)
}

// Path returns the record path inside root.
func Path(root string) string { return filepath.Join(root, FileName) }

// Read loads and validates the record at path.
func Read(path string) (*Record, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("%w: %s", ErrMissing, path)
		}
		return nil, err
	}
	r, err := Parse(data)
	if err != nil {
		return nil, &CorruptError{Path: path, Reason: err.Error()}
	}
	return r, nil
}

// Parse decodes and validates install.json bytes with the same rules as installRecordSchema.
func Parse(data []byte) (*Record, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("invalid JSON: %v", err)
	}
	if raw == nil {
		return nil, errors.New("not a JSON object")
	}
	r := &Record{extra: map[string]json.RawMessage{}}
	known := map[string]bool{}
	for _, k := range knownKeys {
		known[k] = true
	}
	for k, v := range raw {
		if !known[k] {
			r.extra[k] = v
		}
	}

	var errs []string
	fail := func(key, msg string) { errs = append(errs, key+": "+msg) }
	str := func(key string, required bool) (string, bool) {
		v, ok := raw[key]
		if !ok {
			if required {
				fail(key, "required")
			}
			return "", false
		}
		var s string
		if err := json.Unmarshal(v, &s); err != nil || string(bytes.TrimSpace(v)) == "null" {
			fail(key, "expected string")
			return "", false
		}
		return s, true
	}
	boolean := func(key string) bool {
		v, ok := raw[key]
		if !ok {
			fail(key, "required")
			return false
		}
		var b bool
		if err := json.Unmarshal(v, &b); err != nil || string(bytes.TrimSpace(v)) == "null" {
			fail(key, "expected boolean")
		}
		return b
	}

	if v, ok := raw["schema"]; !ok {
		fail("schema", "required")
	} else if string(bytes.TrimSpace(v)) != "1" {
		fail("schema", "expected 1")
	} else {
		r.Schema = 1
	}
	if s, ok := str("platform", true); ok {
		if !platforms[s] {
			fail("platform", "unknown platform "+s)
		}
		r.Platform = s
	}
	if s, ok := str("root", true); ok {
		if s == "" {
			fail("root", "empty")
		}
		r.Root = s
	}
	if s, ok := str("appPath", false); ok {
		if s == "" {
			fail("appPath", "empty")
		}
		r.AppPath = s
	}
	if s, ok := str("dataRoot", true); ok {
		if s == "" {
			fail("dataRoot", "empty")
		}
		r.DataRoot = s
	}
	r.Portable = boolean("portable")
	if s, ok := str("channel", true); ok {
		if !channels[s] {
			fail("channel", "unknown channel "+s)
		}
		r.Channel = s
	}
	for _, f := range []struct {
		key      string
		dst      *string
		required bool
	}{{"current", &r.Current, true}, {"previous", &r.Previous, false}, {"pending", &r.Pending, false}} {
		if s, ok := str(f.key, f.required); ok {
			if !IsSemver(s) {
				fail(f.key, "not a semver version")
			}
			*f.dst = s
		}
	}
	r.Failed = []string{}
	if v, ok := raw["failed"]; ok {
		var list []string
		if err := json.Unmarshal(v, &list); err != nil || string(bytes.TrimSpace(v)) == "null" {
			fail("failed", "expected array of versions")
		} else {
			for _, s := range list {
				if !IsSemver(s) {
					fail("failed", "not a semver version: "+s)
				}
			}
			r.Failed = list
		}
	}
	r.Confirmed = boolean("confirmed")
	if s, ok := str("installedAt", true); ok {
		r.InstalledAt = s
	}
	if s, ok := str("updatedAt", true); ok {
		r.UpdatedAt = s
	}
	if len(errs) > 0 {
		sort.Strings(errs)
		return nil, errors.New(joinErrs(errs))
	}
	return r, nil
}

func joinErrs(errs []string) string {
	var b bytes.Buffer
	for i, e := range errs {
		if i > 0 {
			b.WriteString("; ")
		}
		b.WriteString(e)
	}
	return b.String()
}

// Extra returns a copy of the unknown keys the record carries.
func (r *Record) Extra() map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(r.extra))
	for k, v := range r.extra {
		out[k] = v
	}
	return out
}

// SetExtra sets an unknown key (used by tests and by migrations).
func (r *Record) SetExtra(key string, value json.RawMessage) {
	if r.extra == nil {
		r.extra = map[string]json.RawMessage{}
	}
	r.extra[key] = value
}

// IsFailed reports whether v is in the failed list.
func (r *Record) IsFailed(v string) bool {
	for _, f := range r.Failed {
		if f == v {
			return true
		}
	}
	return false
}

// MarkFailed adds v to the failed list once.
func (r *Record) MarkFailed(v string) {
	if v != "" && !r.IsFailed(v) {
		r.Failed = append(r.Failed, v)
	}
}

// Touch sets updatedAt to now in the format the app uses (Date.toISOString()).
func (r *Record) Touch(now time.Time) {
	r.UpdatedAt = now.UTC().Format("2006-01-02T15:04:05.000Z")
}

// Marshal encodes the record: known keys in schema order, then unknown keys sorted, two-space
// indent and a trailing newline (JSON.stringify(record, null, 2) + "\n").
func (r *Record) Marshal() ([]byte, error) {
	type kv struct {
		k string
		v any
	}
	var fields []kv
	add := func(k string, v any) { fields = append(fields, kv{k, v}) }
	add("schema", 1)
	add("platform", r.Platform)
	add("root", r.Root)
	if r.AppPath != "" {
		add("appPath", r.AppPath)
	}
	add("dataRoot", r.DataRoot)
	add("portable", r.Portable)
	add("channel", r.Channel)
	add("current", r.Current)
	if r.Previous != "" {
		add("previous", r.Previous)
	}
	if r.Pending != "" {
		add("pending", r.Pending)
	}
	failed := r.Failed
	if failed == nil {
		failed = []string{}
	}
	add("failed", failed)
	add("confirmed", r.Confirmed)
	add("installedAt", r.InstalledAt)
	add("updatedAt", r.UpdatedAt)
	extraKeys := make([]string, 0, len(r.extra))
	for k := range r.extra {
		extraKeys = append(extraKeys, k)
	}
	sort.Strings(extraKeys)
	for _, k := range extraKeys {
		add(k, r.extra[k])
	}

	var buf bytes.Buffer
	buf.WriteString("{")
	for i, f := range fields {
		if i > 0 {
			buf.WriteString(",")
		}
		key, _ := marshalNoEscape(f.k)
		val, err := marshalNoEscape(f.v)
		if err != nil {
			return nil, fmt.Errorf("encode %s: %w", f.k, err)
		}
		buf.Write(key)
		buf.WriteString(":")
		buf.Write(val)
	}
	buf.WriteString("}")
	var out bytes.Buffer
	if err := json.Indent(&out, buf.Bytes(), "", "  "); err != nil {
		return nil, err
	}
	out.WriteString("\n")
	return out.Bytes(), nil
}

// marshalNoEscape is json.Marshal without HTML escaping, matching JSON.stringify.
func marshalNoEscape(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(b.Bytes(), "\n"), nil
}

// Write stores the record atomically at path (temp file in the same directory, fsync, rename).
func Write(path string, r *Record) error {
	data, err := r.Marshal()
	if err != nil {
		return err
	}
	return fsutil.WriteFileAtomic(path, data, 0o644)
}
