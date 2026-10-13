// GUIPBX — визуальный конструктор сценариев Asterisk.
// Единый бинарник: веб-интерфейс (embed) + REST API + подключение к станции по AMI.
package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"
)

//go:embed public
var publicFS embed.FS

const version = "1.1.1"

func main() {
	ensureSeedData()

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	mux := http.NewServeMux()

	// мета
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"ok": true, "name": "GUIPBX", "version": version, "time": nowISO(), "engine": "go"})
	})

	// схемы
	mux.HandleFunc("GET /api/schemes", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, listSchemes())
	})
	mux.HandleFunc("POST /api/schemes", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Name string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		name := limitStr(b.Name, 120)
		if name == "" {
			name = "Новая схема"
		}
		sc := &Scheme{ID: "s" + base36(time.Now().UnixMilli()), Name: name, Description: "", Nodes: []Node{}, Edges: []Edge{}, UpdatedAt: nowISO()}
		if err := writeScheme(sc); err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		writeJSON(w, sc)
	})
	mux.HandleFunc("GET /api/schemes/{id}", func(w http.ResponseWriter, r *http.Request) {
		sc, err := readScheme(r.PathValue("id"))
		if err != nil {
			writeErr(w, 404, "Схема не найдена")
			return
		}
		writeJSON(w, sc)
	})
	mux.HandleFunc("PUT /api/schemes/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if _, err := readScheme(id); err != nil {
			writeErr(w, 404, "Схема не найдена")
			return
		}
		var b Scheme
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 6<<20)).Decode(&b); err != nil {
			writeErr(w, 400, "некорректный JSON: "+err.Error())
			return
		}
		prev, _ := readScheme(id)
		sc := &Scheme{
			ID:          id,
			Name:        limitStr(b.Name, 120),
			Description: limitStr(b.Description, 500),
			Nodes:       b.Nodes,
			Edges:       b.Edges,
			UpdatedAt:   nowISO(),
		}
		if prev != nil {
			sc.StationContext = limitStr(defaultStr(b.StationContext, prev.StationContext), 80)
		}
		if sc.Name == "" {
			sc.Name = "Схема"
		}
		if sc.Nodes == nil {
			sc.Nodes = []Node{}
		}
		if sc.Edges == nil {
			sc.Edges = []Edge{}
		}
		if err := writeScheme(sc); err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		writeJSON(w, map[string]any{"ok": true, "updatedAt": sc.UpdatedAt})
	})
	mux.HandleFunc("DELETE /api/schemes/{id}", func(w http.ResponseWriter, r *http.Request) {
		if err := deleteScheme(r.PathValue("id")); err != nil {
			writeErr(w, 404, "Схема не найдена")
			return
		}
		writeJSON(w, map[string]any{"ok": true})
	})

	// компиляция
	mux.HandleFunc("GET /api/schemes/{id}/compile", func(w http.ResponseWriter, r *http.Request) {
		sc, err := readScheme(r.PathValue("id"))
		if err != nil {
			writeErr(w, 404, "Схема не найдена")
			return
		}
		reg, err := readRegistry()
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		sr := compileScheme(sc, reg)
		pr := compileProject([]*Scheme{sc}, reg)
		writeJSON(w, map[string]any{"extensions": sr.extensions, "pjsip": pr.Pjsip, "queues": pr.Queues, "warnings": sr.warnings})
	})
	mux.HandleFunc("GET /api/project/compile", func(w http.ResponseWriter, r *http.Request) {
		reg, err := readRegistry()
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		writeJSON(w, compileProject(readAllSchemes(), reg))
	})
	mux.HandleFunc("GET /api/project/download", func(w http.ResponseWriter, r *http.Request) {
		reg, err := readRegistry()
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		c := compileProject(readAllSchemes(), reg)
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="extensions_gui.conf"`)
		_, _ = w.Write([]byte(c.Extensions))
	})

	// реестр
	mux.HandleFunc("GET /api/registry", func(w http.ResponseWriter, r *http.Request) {
		reg, err := readRegistry()
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		writeJSON(w, reg)
	})
	mux.HandleFunc("PUT /api/registry", func(w http.ResponseWriter, r *http.Request) {
		var b Registry
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&b); err != nil {
			writeErr(w, 400, "некорректный JSON: "+err.Error())
			return
		}
		reg := sanitizeRegistry(&b)
		if err := writeRegistry(reg); err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		writeJSON(w, map[string]any{"ok": true, "devices": len(reg.Devices), "trunks": len(reg.Trunks)})
	})

	// деплой в файл на хосте GUIPBX
	mux.HandleFunc("POST /api/deploy", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			TargetPath string `json:"targetPath"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		target := defaultStr(b.TargetPath, envOr("GUIPBX_DEPLOY_PATH", "/etc/asterisk/extensions_gui.conf"))
		reg, err := readRegistry()
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		c := compileProject(readAllSchemes(), reg)
		if err := os.WriteFile(target, []byte(c.Extensions), 0o644); err != nil {
			writeJSON(w, map[string]any{"ok": false, "error": fmt.Sprintf("Не удалось записать %s: %s", target, err.Error()), "hint": "Скачайте файл и скопируйте вручную, либо запустите GUIPBX на хосте Asterisk."})
			return
		}
		writeJSON(w, map[string]any{"ok": true, "path": target, "bytes": len(c.Extensions), "warnings": c.Warnings})
	})

	// станция (AMI)
	mux.HandleFunc("POST /api/station/connect", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Host   string `json:"host"`
			Port   int    `json:"port"`
			User   string `json:"user"`
			Secret string `json:"secret"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			writeErr(w, 400, "некорректный JSON")
			return
		}
		b.Host = strings.TrimSpace(b.Host)
		if b.Host == "" {
			writeErr(w, 400, "Укажите IP адрес станции")
			return
		}
		if b.Port <= 0 || b.Port > 65535 {
			b.Port = 5038
		}
		banner, err := amiTest(b.Host, b.Port, b.User, b.Secret)
		if err != nil {
			writeErr(w, 502, err.Error())
			return
		}
		setStation(&stationSession{Host: b.Host, Port: b.Port, User: b.User, Secret: b.Secret, Banner: banner, ConnectedAt: time.Now().UTC()})
		writeJSON(w, map[string]any{"ok": true, "banner": banner})
	})
	mux.HandleFunc("POST /api/station/disconnect", func(w http.ResponseWriter, r *http.Request) {
		setStation(nil)
		writeJSON(w, map[string]any{"ok": true})
	})
	// произвольная CLI-команда на станции (например, "dialplan reload")
	mux.HandleFunc("POST /api/station/command", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Command string `json:"command"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || strings.TrimSpace(b.Command) == "" {
			writeErr(w, 400, "укажите команду")
			return
		}
		responses, err := amiOnStation([]string{b.Command})
		if err != nil {
			writeErr(w, 502, err.Error())
			return
		}
		out := make([]string, 0, len(responses))
		for _, rb := range responses {
			out = append(out, amiFriendly(b.Command, rb))
		}
		writeJSON(w, map[string]any{"ok": true, "responses": out})
	})
	mux.HandleFunc("GET /api/station/status", func(w http.ResponseWriter, r *http.Request) {
		s := currentStation()
		if s == nil {
			writeJSON(w, map[string]any{"connected": false})
			return
		}
		writeJSON(w, map[string]any{
			"connected": true, "host": s.Host, "port": s.Port, "user": s.User,
			"banner": s.Banner, "connectedAt": s.ConnectedAt.Format(time.RFC3339),
		})
	})

	// чтение существующих настроек со станции
	mux.HandleFunc("GET /api/station/contexts", func(w http.ResponseWriter, r *http.Request) {
		dump, err := stationDialplanShow()
		if err != nil {
			writeErr(w, 502, err.Error())
			return
		}
		out := []map[string]any{}
		for _, dc := range dump {
			out = append(out, map[string]any{
				"name": dc.Name, "extens": dc.extenCount(), "priorities": dc.priorityCount(),
				"ours": strings.HasPrefix(dc.Name, "gui-"),
			})
		}
		writeJSON(w, out)
	})
	mux.HandleFunc("GET /api/station/dialplan-raw", func(w http.ResponseWriter, r *http.Request) {
		s := currentStation()
		if s == nil {
			writeErr(w, 503, "нет подключения к станции")
			return
		}
		_, responses, err := amiRun(s.Host, s.Port, s.User, s.Secret, []AMIAction{{Action: "Command", Command: "dialplan show"}})
		if err != nil {
			writeErr(w, 502, err.Error())
			return
		}
		text := ""
		if len(responses) > 0 {
			text = amiOutput(responses[0])
		}
		writeJSON(w, map[string]any{"raw": text})
	})
	mux.HandleFunc("POST /api/station/import", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Contexts []string `json:"contexts"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || len(b.Contexts) == 0 {
			writeErr(w, 400, "укажите контексты для импорта")
			return
		}
		dump, err := stationDialplanShow()
		if err != nil {
			writeErr(w, 502, err.Error())
			return
		}
		byName := map[string]DumpContext{}
		for _, dc := range dump {
			byName[dc.Name] = dc
		}
		created := []map[string]string{}
		warnings := []string{}
		for _, name := range b.Contexts {
			dc, ok := byName[name]
			if !ok {
				warnings = append(warnings, "Контекст «"+name+"» не найден на станции.")
				continue
			}
			id := uniqueSchemeID(slugify(name))
			sc, w := importContext(dc, id, "["+name+"] из станции")
			sc.StationContext = name
			if err := writeScheme(sc); err != nil {
				warnings = append(warnings, fmt.Sprintf("Контекст «%s»: не сохранён: %s", name, err.Error()))
				continue
			}
			for _, x := range w {
				warnings = append(warnings, "["+name+"] "+x)
			}
			created = append(created, map[string]string{"id": id, "name": sc.Name, "from": name})
		}
		writeJSON(w, map[string]any{"ok": true, "schemes": created, "warnings": warnings})
	})

	// запись схемы обратно на станцию
	mux.HandleFunc("POST /api/station/push", func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			SchemeID string `json:"schemeId"`
			Force    bool   `json:"force"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.SchemeID == "" {
			writeErr(w, 400, "укажите schemeId")
			return
		}
		if currentStation() == nil {
			writeErr(w, 503, "нет подключения к станции")
			return
		}
		sc, err := readScheme(b.SchemeID)
		if err != nil {
			writeErr(w, 404, "Схема не найдена")
			return
		}
		reg, err := readRegistry()
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		sr := compileScheme(sc, reg)
		commands, contexts, err := contextsToCLI(sr.extensions)
		if err != nil {
			writeErr(w, 400, "сборка команд: "+err.Error())
			return
		}
		if len(commands) == 0 {
			writeErr(w, 400, "схема не генерирует контекстов (нет точки входа)")
			return
		}
		dirty := []string{}
		for _, c := range contexts {
			if !strings.HasPrefix(c, "gui-") {
				dirty = append(dirty, c)
			}
		}
		if len(dirty) > 0 && !b.Force {
			writeJSON(w, map[string]any{
				"ok": false, "needForce": true, "contexts": dirty,
				"error": "Выгрузка перезапишет контексты станции: " + strings.Join(dirty, ", ") + ". Подтвердите операцию.",
			})
			return
		}
		commands = append(commands, "dialplan reload")
		responses, err := amiOnStation(commands)
		if err != nil {
			writeErr(w, 502, err.Error())
			return
		}
		out := make([]string, 0, len(responses))
		for i, rb := range responses {
			cmd := ""
			if i < len(commands) {
				cmd = commands[i]
			}
			out = append(out, amiFriendly(cmd, rb))
		}
		writeJSON(w, map[string]any{
			"ok": true, "contexts": contexts, "commands": len(commands), "responses": out, "warnings": sr.warnings,
		})
	})

	// статика SPA
	pub, err := fs.Sub(publicFS, "public")
	if err != nil {
		log.Fatal(err)
	}
	mux.Handle("GET /", spaHandler(pub))

	addr := "0.0.0.0:" + port
	log.Printf("GUIPBX (Go) %s запущен: http://%s", version, addr)
	log.Printf("Веб-интерфейс: откройте в браузере http://localhost:%s", port)
	log.Printf("Данные: %s", dataDir)
	if os.Getenv("GUIPBX_NOBROWSER") == "" {
		// поднимаем браузер сами — бинарник рассчитан на «запустил и работаешь»
		go func() {
			time.Sleep(500 * time.Millisecond)
			openBrowser("http://localhost:" + port)
		}()
	}
	if err := http.ListenAndServe(addr, noStore(mux)); err != nil {
		log.Fatal(err)
	}
}

// openBrowser открывает URL в системном браузере (best-effort, без ошибок).
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

// ── helpers ─────────────────────────────────────────────────

func stationDialplanShow() ([]DumpContext, error) {
	s := currentStation()
	if s == nil {
		return nil, fmt.Errorf("нет подключения к станции")
	}
	_, responses, err := amiRun(s.Host, s.Port, s.User, s.Secret, []AMIAction{{Action: "Command", Command: "dialplan show"}})
	if err != nil {
		return nil, err
	}
	if len(responses) == 0 {
		return nil, fmt.Errorf("пустой ответ станции")
	}
	text := amiOutput(responses[0])
	ctxs := parseDialplanShow(text)
	if len(ctxs) == 0 {
		return nil, fmt.Errorf("диалплан пуст или не разобран (%d байт ответа)", len(text))
	}
	return ctxs, nil
}

var slugRe = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

func slugify(s string) string {
	s = strings.Trim(slugRe.ReplaceAllString(strings.ToLower(s), "-"), "-")
	if s == "" {
		s = "ctx"
	}
	// компактнее: убираем длинные тире
	for strings.Contains(s, "--") {
		s = strings.ReplaceAll(s, "--", "-")
	}
	if len(s) > 30 {
		s = s[:30]
	}
	return s
}

func schemeExists(id string) bool {
	_, err := os.Stat(schemeFile(id))
	return err == nil
}

func uniqueSchemeID(base string) string {
	if !schemeExists(base) {
		return base
	}
	for i := 2; ; i++ {
		id := fmt.Sprintf("%s-%d", base, i)
		if !schemeExists(id) {
			return id
		}
	}
}

var numRe = regexp.MustCompile(`[^0-9*#]`)
var trunkNameRe = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

func sanitizeRegistry(b *Registry) *Registry {
	devs := []Device{}
	for _, d := range b.Devices {
		d.Number = numRe.ReplaceAllString(d.Number, "")
		if d.Number == "" {
			continue
		}
		d.Name = limitStr(d.Name, 80)
		d.Secret = limitStr(d.Secret, 64)
		d.Context = defaultStr(limitStr(d.Context, 40), "gui-internal")
		devs = append(devs, d)
	}
	trunks := []Trunk{}
	for _, t := range b.Trunks {
		t.Name = trunkNameRe.ReplaceAllString(t.Name, "")
		t.Host = limitStr(t.Host, 120)
		if t.Name == "" || t.Host == "" {
			continue
		}
		if t.Port <= 0 || t.Port > 65535 {
			t.Port = 5060
		}
		t.Username = limitStr(t.Username, 80)
		t.Password = limitStr(t.Password, 120)
		t.Context = limitStr(t.Context, 40)
		trunks = append(trunks, t)
	}
	return &Registry{Devices: devs, Trunks: trunks}
}

func spaHandler(root fs.FS) http.Handler {
	files := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		if f, err := root.Open(p); err == nil {
			_ = f.Close()
			files.ServeHTTP(w, r)
			return
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/"
		files.ServeHTTP(w, r2)
	})
}

func noStore(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		h.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func base36(v int64) string {
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var b [16]byte
	i := len(b)
	for v > 0 {
		i--
		b[i] = digits[v%36]
		v /= 36
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

func limitStr(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}
