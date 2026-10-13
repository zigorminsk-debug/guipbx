// Хранение схем и реестра устройств/транков в JSON-файлах (data/).
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ── модели ──────────────────────────────────────────────────

type PortRef struct {
	Node string `json:"node"`
	Port string `json:"port"`
}

type Node struct {
	ID   string         `json:"id"`
	Type string         `json:"type"`
	X    float64        `json:"x"`
	Y    float64        `json:"y"`
	Data map[string]any `json:"data"`
}

type Edge struct {
	ID   string  `json:"id"`
	From PortRef `json:"from"`
	To   struct {
		Node string `json:"node"`
	} `json:"to"`
}

type Scheme struct {
	ID          string  `json:"id"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Nodes       []Node  `json:"nodes"`
	Edges       []Edge  `json:"edges"`
	UpdatedAt   string  `json:"updatedAt,omitempty"`
	// StationContext — исходный контекст станции, из которого схема импортирована.
	// При выгрузке на станцию контекст будет перезаписан по этому имени.
	StationContext string `json:"stationContext,omitempty"`
}

type Device struct {
	Name    string `json:"name"`
	Number  string `json:"number"`
	Secret  string `json:"secret"`
	Context string `json:"context"`
}

type Trunk struct {
	Name     string `json:"name"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
	Register bool   `json:"register"`
	Inbound  bool   `json:"inbound"`
	Context  string `json:"context,omitempty"`
}

type Registry struct {
	Devices []Device `json:"devices"`
	Trunks  []Trunk  `json:"trunks"`
}

type SchemeMeta struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Nodes       int    `json:"nodes"`
	Edges       int    `json:"edges"`
	UpdatedAt   string `json:"updatedAt,omitempty"`
}

// ── пути ────────────────────────────────────────────────────

var dataDir = envOr("GUIPBX_DATA", "data")

func schemesDir() string   { return filepath.Join(dataDir, "schemes") }
func registryPath() string { return filepath.Join(dataDir, "registry.json") }

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

var idRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,40}$`)

func validID(id string) bool { return idRe.MatchString(id) }

// ── схемы ───────────────────────────────────────────────────

func schemeFile(id string) string { return filepath.Join(schemesDir(), id+".json") }

func listSchemes() []SchemeMeta {
	entries, _ := os.ReadDir(schemesDir())
	out := make([]SchemeMeta, 0, len(entries))
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		sc, err := readScheme(strings.TrimSuffix(e.Name(), ".json"))
		if err != nil {
			continue
		}
		out = append(out, SchemeMeta{
			ID: sc.ID, Name: sc.Name, Description: sc.Description,
			Nodes: len(sc.Nodes), Edges: len(sc.Edges), UpdatedAt: sc.UpdatedAt,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func readScheme(id string) (*Scheme, error) {
	if !validID(id) {
		return nil, fmt.Errorf("недопустимый идентификатор")
	}
	b, err := os.ReadFile(schemeFile(id))
	if err != nil {
		return nil, err
	}
	var sc Scheme
	if err := json.Unmarshal(b, &sc); err != nil {
		return nil, err
	}
	sc.ID = id
	return &sc, nil
}

func writeScheme(sc *Scheme) error {
	if err := os.MkdirAll(schemesDir(), 0o755); err != nil {
		return err
	}
	tmp := schemeFile(sc.ID) + ".tmp"
	b, err := json.MarshalIndent(sc, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, schemeFile(sc.ID))
}

func deleteScheme(id string) error {
	if !validID(id) {
		return fmt.Errorf("недопустимый идентификатор")
	}
	return os.Remove(schemeFile(id))
}

func readAllSchemes() []*Scheme {
	metas := listSchemes()
	out := make([]*Scheme, 0, len(metas))
	for _, m := range metas {
		if sc, err := readScheme(m.ID); err == nil {
			out = append(out, sc)
		}
	}
	return out
}

// ── реестр ──────────────────────────────────────────────────

func readRegistry() (*Registry, error) {
	b, err := os.ReadFile(registryPath())
	if err != nil {
		return nil, err
	}
	var r Registry
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, err
	}
	if r.Devices == nil {
		r.Devices = []Device{}
	}
	if r.Trunks == nil {
		r.Trunks = []Trunk{}
	}
	return &r, nil
}

func writeRegistry(r *Registry) error {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(registryPath(), b, 0o644)
}

// ── утилиты ─────────────────────────────────────────────────

func nowISO() string { return time.Now().UTC().Format(time.RFC3339) }

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func ensureSeedData() {
	if err := os.MkdirAll(schemesDir(), 0o755); err != nil {
		return
	}
	if _, err := os.Stat(registryPath()); os.IsNotExist(err) {
		_ = writeRegistry(demoRegistry())
	}
	if entries, _ := os.ReadDir(schemesDir()); len(entries) == 0 {
		_ = writeScheme(demoScheme())
		_ = writeScheme(demoSchemeOutbound())
	}
}
