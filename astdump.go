// Обратное преобразование: чтение существующего диалплана станции
// ("dialplan show" по AMI) и построение из него визуальной схемы GUIPBX —
// блоки и связи с авто-раскладкой. Поддерживаются собственные сгенерированные
// контексты (круговой импорт) и «чужой» ручной диалплан (неизвестные
// приложения становятся блоками «Своя команда»).
package main

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ── структуры разобранного дампа ────────────────────────────

type DumpStep struct {
	Exten string
	Prio  int
	Label string
	App   string
	Args  string
	Raw   string
}

type DumpExten struct {
	Pattern string
	Steps   []DumpStep
}

type DumpContext struct {
	Name   string      `json:"name"`
	Extens []DumpExten `json:"extens"`
}

func (dc *DumpContext) extenCount() int { return len(dc.Extens) }

func (dc *DumpContext) priorityCount() int {
	n := 0
	for _, e := range dc.Extens {
		n += len(e.Steps)
	}
	return n
}

// ── парсер вывода "dialplan show" ───────────────────────────

var (
	reDumpCtx   = regexp.MustCompile(`^\[\s*Context\s+'([^']+)'`)
	reDumpExten = regexp.MustCompile(`^\s+'([^']+)'\s*=>\s*(\d+)(?:\(([^)]*)\))?\.\s*(.*)$`)
	reDumpNext  = regexp.MustCompile(`^\s+(\d+)(?:\(([^)]*)\))?\.\s*(.*)$`)
	reDumpSrc   = regexp.MustCompile(`\s+\[[^\]]+\]\s*$`)
)

// parseDialplanShow разбирает текст команды "dialplan show".
func parseDialplanShow(text string) []DumpContext {
	ctxs := []DumpContext{}
	var cur *DumpContext
	var curExten *DumpExten

	flush := func() {
		if cur != nil && curExten != nil {
			cur.Extens = append(cur.Extens, *curExten)
			curExten = nil
		}
		if cur != nil && len(cur.Extens) > 0 {
			ctxs = append(ctxs, *cur)
		}
	}

	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.HasPrefix(line, "-=") {
			continue // футер статистики
		}
		if m := reDumpCtx.FindStringSubmatch(line); m != nil {
			flush()
			cur = &DumpContext{Name: m[1]}
			continue
		}
		if cur == nil {
			continue
		}
		if strings.Contains(line, "Include in context") || strings.Contains(line, "hint:") ||
			strings.Contains(line, "CID match") || strings.Contains(line, "Ignore pattern") {
			continue
		}
		if m := reDumpExten.FindStringSubmatch(line); m != nil {
			if curExten != nil {
				cur.Extens = append(cur.Extens, *curExten)
			}
			curExten = &DumpExten{Pattern: m[1]}
			prio, _ := strconv.Atoi(m[2])
			app, args := splitApp(strings.TrimSpace(reDumpSrc.ReplaceAllString(m[4], "")))
			curExten.Steps = append(curExten.Steps, DumpStep{Exten: m[1], Prio: prio, Label: m[3], App: app, Args: args, Raw: strings.TrimSpace(m[4])})
			continue
		}
		if m := reDumpNext.FindStringSubmatch(line); m != nil {
			if curExten == nil {
				continue
			}
			prio, _ := strconv.Atoi(m[1])
			app, args := splitApp(strings.TrimSpace(reDumpSrc.ReplaceAllString(m[3], "")))
			curExten.Steps = append(curExten.Steps, DumpStep{Exten: curExten.Pattern, Prio: prio, Label: m[2], App: app, Args: args, Raw: strings.TrimSpace(m[3])})
			continue
		}
	}
	flush()
	return ctxs
}

// splitApp делит "NoOp(текст)" на имя приложения и аргументы.
func splitApp(s string) (app, args string) {
	i := strings.Index(s, "(")
	if i < 0 {
		return s, ""
	}
	app = s[:i]
	args = ""
	if strings.HasSuffix(s, ")") {
		args = s[i+1 : len(s)-1]
	} else {
		args = s[i+1:]
	}
	return app, args
}

// ── импорт контекста в схему ────────────────────────────────

type pendRef struct {
	fromNode string
	port     string
	exten    string
	spec     string
}

type importer struct {
	ctx      DumpContext
	scheme   *Scheme
	seq      int
	warnings []string

	posLink  map[string]string // "extenAAidx" -> nodeID, начавшемуся на этой позиции
	consumed map[string]bool
	pending  []pendRef
	ivrNodes []string
}

func posKey(exten string, idx int) string { return exten + "\x00" + strconv.Itoa(idx) }

func importContext(dc DumpContext, schemeID, name string) (*Scheme, []string) {
	im := &importer{
		ctx:      dc,
		scheme:   &Scheme{ID: schemeID, Name: name, Description: "Импортировано со станции · контекст [" + dc.Name + "]"},
		posLink:  map[string]string{},
		consumed: map[string]bool{},
	}

	// 1) основные проходы: каждый exten как точка входа (не цифровые меню)
	for ei := range dc.Extens {
		pat := dc.Extens[ei].Pattern
		if isDigitExten(pat) {
			continue // свяжем с IVR ниже
		}
		entryData := map[string]any{}
		typ := "inbound"
		if strings.HasPrefix(pat, "_") || strings.Contains(dc.Name, "-out-") {
			typ = "outbound"
			entryData["pattern"] = pat
		} else {
			entryData["did"] = pat
		}
		entry := im.newNode(typ, entryData)
		first := im.walk(pat, 0)
		if first != "" {
			im.link(entry, "out", first)
		}
	}

	// 2) цифровые extension-ы — ветки IVR
	for ei := range dc.Extens {
		pat := dc.Extens[ei].Pattern
		if !isDigitExten(pat) {
			continue
		}
		if len(im.ivrNodes) == 0 {
			continue // меню без Background+WaitExten — попадёт в осиротевшие ниже
		}
		ivrID := im.ivrNodes[0]
		if len(im.ivrNodes) > 1 {
			im.warn("Несколько IVR в контексте: цифровые extension-ы привязаны к первому.")
		}
		port := "k" + pat
		if pat == "t" {
			port = "kt"
		} else if pat == "i" {
			port = "ki"
		}
		first := im.walk(pat, 0)
		if first != "" {
			im.link(ivrID, port, first)
		}
	}

	// 3) осиротевшие непотреблённые шаги
	orphans := 0
	for ei := range dc.Extens {
		pat := dc.Extens[ei].Pattern
		for idx := range dc.Extens[ei].Steps {
			if im.consumed[posKey(pat, idx)] {
				continue
			}
			if im.walk(pat, idx) != "" {
				orphans++
			}
		}
	}
	if orphans > 0 {
		im.warn("Свободные участки диалплана без точки входа: %d шт. — нарисованы отдельно.", orphans)
	}

	// 4) разрешение отложенных ссылок (Goto/GotoIf/... на ещё не отрисованные цепочки)
	for i := 0; i < len(im.pending); i++ {
		p := im.pending[i]
		target := im.resolvePos(p.exten, p.spec)
		if target == -1 {
			im.warn("Переход на %s,%s не удалось разрешить — связь %s/%s пропущена.", p.exten, p.spec, p.fromNode, p.port)
			continue
		}
		node := im.walk(p.exten, target)
		if node == "" {
			node = im.posLink[posKey(p.exten, target)]
		}
		if node != "" {
			im.link(p.fromNode, p.port, node)
		} else {
			im.warn("Переход на %s,%s указывает на пустую позицию.", p.exten, p.spec)
		}
	}

	// 5) IVR-порты: если у IVR нет ключа t — пометим useT=false
	for _, id := range im.ivrNodes {
		n := im.nodeByID(id)
		hasT := false
		for _, e := range im.scheme.Edges {
			if e.From.Node == id && e.From.Port == "kt" {
				hasT = true
			}
		}
		n.Data["useT"] = hasT
		n.Data["useI"] = false
		for _, e := range im.scheme.Edges {
			if e.From.Node == id && e.From.Port == "ki" {
				n.Data["useI"] = true
			}
		}
		// набор клавиш по существующим связям
		keysSet := map[string]bool{}
		keys := []any{}
		for _, e := range im.scheme.Edges {
			if e.From.Node == id && strings.HasPrefix(e.From.Port, "k") && len(e.From.Port) <= 3 {
				k := e.From.Port[1:]
				if k != "t" && k != "i" && !keysSet[k] {
					keysSet[k] = true
					keys = append(keys, k)
				}
			}
		}
		sort.Slice(keys, func(i, j int) bool { return keys[i].(string) < keys[j].(string) })
		if kk, ok := n.Data["keys"].([]any); !ok || len(kk) == 0 {
			n.Data["keys"] = keys
		}
	}

	im.layout()
	im.scheme.UpdatedAt = nowISO()
	return im.scheme, im.warnings
}

func (im *importer) warn(format string, args ...any) {
	im.warnings = append(im.warnings, fmt.Sprintf(format, args...))
}

func (im *importer) newNode(typ string, data map[string]any) string {
	im.seq++
	id := fmt.Sprintf("imp%d", im.seq)
	if data == nil {
		data = map[string]any{}
	}
	im.scheme.Nodes = append(im.scheme.Nodes, Node{ID: id, Type: typ, Data: data})
	return id
}

func (im *importer) nodeByID(id string) *Node {
	for i := range im.scheme.Nodes {
		if im.scheme.Nodes[i].ID == id {
			return &im.scheme.Nodes[i]
		}
	}
	return nil
}

func (im *importer) link(from, port, to string) {
	if from == "" || to == "" {
		return
	}
	im.seq++
	im.scheme.Edges = append(im.scheme.Edges, mkEdge(fmt.Sprintf("i%d", im.seq), from, port, to))
}

// resolvePos находит индекс шага по спецификатору приоритета (число или метка).
func (im *importer) resolvePos(exten, spec string) int {
	for ei := range im.ctx.Extens {
		if im.ctx.Extens[ei].Pattern != exten {
			continue
		}
		steps := im.ctx.Extens[ei].Steps
		if n, err := strconv.Atoi(spec); err == nil {
			for i, s := range steps {
				if s.Prio == n {
					return i
				}
			}
			return -1
		}
		for i, s := range steps {
			if s.Label != "" && s.Label == spec {
				return i
			}
		}
		return -1
	}
	return -1
}

// linkToPos создаёт связь на позицию диалплана: сразу, если она уже отрисована,
// иначе — отложенно (после отрисовки всех цепочек).
func (im *importer) linkToPos(from, port, exten, spec string) {
	idx := im.resolvePos(exten, spec)
	if idx >= 0 {
		if node, ok := im.posLink[posKey(exten, idx)]; ok {
			im.link(from, port, node)
			return
		}
	}
	im.pending = append(im.pending, pendRef{fromNode: from, port: port, exten: exten, spec: spec})
}

// walk отрисовывает линейную цепочку шагов, начиная с позиции (exten, idx).
// Возвращает id первого созданного на цепочке блока (или "" если всё было потреблено).
func (im *importer) walk(exten string, idx int) string {
	steps := im.stepsOf(exten)
	if idx >= len(steps) || idx < 0 {
		return ""
	}
	if node, ok := im.posLink[posKey(exten, idx)]; ok {
		return node // позиция уже на карте — просто целимся в неё
	}

	first := ""
	prevNode, prevPort := "", ""
	chainDone := false
	var deferred []string // позиции маркеров NoOp, ожидающие привязки к следующему блоку

	attach := func(nodeID string) {
		if first == "" {
			first = nodeID
		}
		for _, dk := range deferred {
			im.posLink[dk] = nodeID
		}
		deferred = nil
		if prevNode != "" {
			im.link(prevNode, prevPort, nodeID)
		}
	}

	for i := idx; i < len(steps) && !chainDone; i++ {
		if im.consumed[posKey(exten, i)] {
			// позиция уже превратилась в блок на другой цепочке — соединяемся с ней
			if node, ok := im.posLink[posKey(exten, i)]; ok {
				if prevNode != "" {
					im.link(prevNode, prevPort, node)
				}
				if first == "" {
					first = node
				}
			}
			return first
		}
		s := steps[i]
		im.consumed[posKey(exten, i)] = true

		switch s.App {
		case "NoOp":
			// служебный маркер начала блока — пропускаем без создания узла
			deferred = append(deferred, posKey(exten, i))
			continue

		case "Set":
			// фильтруем служебные переменные, генерируемые GUIPBX
			if strings.HasPrefix(s.Args, "CHANNEL(language)") || strings.HasPrefix(s.Args, "__REC_FILE") ||
				strings.HasPrefix(s.Args, "__OUTNUM") || strings.HasPrefix(s.Args, "DIAL_TRUNK") {
				deferred = append(deferred, posKey(exten, i))
				continue
			}
			node := im.mapSet(s)
			im.posLink[posKey(exten, i)] = node
			attach(node)
			prevNode, prevPort = node, "out"

		case "Background":
			// Background + WaitExten (+Hangup) = IVR
			greeting := s.Args
			timeout := 10
			useWait := false
			if i+1 < len(steps) && steps[i+1].App == "WaitExten" && !im.consumed[posKey(exten, i+1)] {
				useWait = true
				im.consumed[posKey(exten, i+1)] = true
				if n, err := strconv.Atoi(strings.TrimSpace(steps[i+1].Args)); err == nil && n > 0 {
					timeout = n
				}
			}
			if useWait {
				node := im.newNode("ivr", map[string]any{
					"greeting": greeting, "timeout": timeout,
					"keys": []any{}, "useT": true, "useI": false,
				})
				im.posLink[posKey(exten, i)] = node
				attach(node)
				im.ivrNodes = append(im.ivrNodes, node)
				// сопутствующий Hangup после WaitExten — часть IVR-узла
				if i+2 < len(steps) && steps[i+2].App == "Hangup" && !im.consumed[posKey(exten, i+2)] {
					im.consumed[posKey(exten, i+2)] = true
					im.posLink[posKey(exten, i+2)] = node
				}
				chainDone = true // у IVR нет линейного выхода
			} else {
				node := im.newNode("playback", map[string]any{"greeting": greeting, "interruptible": true})
				im.posLink[posKey(exten, i)] = node
				attach(node)
				prevNode, prevPort = node, "out"
			}

		case "WaitExten":
			node := im.newNode("custom", map[string]any{"app": "WaitExten", "args": s.Args})
			im.posLink[posKey(exten, i)] = node
			attach(node)
			prevNode, prevPort = node, "out"

		case "Answer":
			d := 0
			if n, err := strconv.Atoi(strings.TrimSpace(s.Args)); err == nil && n > 0 {
				d = n / 1000
			}
			node := im.newNode("answer", map[string]any{"delay": d})
			im.posLink[posKey(exten, i)] = node
			attach(node)
			prevNode, prevPort = node, "out"

		case "Playback":
			node := im.newNode("playback", map[string]any{"greeting": s.Args, "interruptible": false})
			im.posLink[posKey(exten, i)] = node
			attach(node)
			prevNode, prevPort = node, "out"

		case "Wait":
			sec, _ := strconv.Atoi(strings.TrimSpace(s.Args))
			if sec <= 0 {
				sec = 1
			}
			node := im.newNode("wait", map[string]any{"seconds": sec})
			im.posLink[posKey(exten, i)] = node
			attach(node)
			prevNode, prevPort = node, "out"

		case "Dial":
			node := im.mapDial(s)
			im.posLink[posKey(exten, i)] = node
			attach(node)
			prevNode, prevPort = node, "out"

		case "Queue":
			name, opts, tmo := "", "", ""
			parts := strings.Split(s.Args, ",")
			if len(parts) > 0 {
				name = parts[0]
			}
			if len(parts) > 1 {
				opts = parts[1]
			}
			if len(parts) > 4 {
				tmo = parts[4]
			}
			to := 0
			if v, err := strconv.Atoi(strings.TrimSpace(tmo)); err == nil {
				to = v
			}
			node := im.newNode("queue", map[string]any{"name": name, "timeout": to, "options": opts})
			im.posLink[posKey(exten, i)] = node
			attach(node)
			prevNode, prevPort = node, "out"

		case "ConfBridge":
			parts := strings.Split(s.Args, ",")
			room := parts[0]
			pin := ""
			if len(parts) > 1 {
				pin = parts[1]
			}
			node := im.newNode("conference", map[string]any{"room": room, "pin": pin})
			im.posLink[posKey(exten, i)] = node
			attach(node)
			prevNode, prevPort = node, "out"

		case "VoiceMail":
			box, vctx, mode := s.Args, "default", "u"
			if at := strings.Index(s.Args, "@"); at >= 0 {
				box = s.Args[:at]
				rest := s.Args[at+1:]
				if c := strings.Index(rest, ","); c >= 0 {
					vctx = rest[:c]
					mode = rest[c+1:]
				}
			}
			node := im.newNode("voicemail", map[string]any{"box": box, "context": vctx, "mode": mode, "exit": false})
			im.posLink[posKey(exten, i)] = node
			attach(node)
			// если сразу после — Hangup, потребляем его "внутри" блока голосовой почты
			if i+1 < len(steps) && steps[i+1].App == "Hangup" && !im.consumed[posKey(exten, i+1)] {
				im.consumed[posKey(exten, i+1)] = true
				im.posLink[posKey(exten, i+1)] = node
			}
			chainDone = true

		case "Hangup":
			node := im.newNode("hangup", map[string]any{"cause": s.Args})
			im.posLink[posKey(exten, i)] = node
			attach(node)
			chainDone = true

		case "Busy":
			sec, _ := strconv.Atoi(strings.TrimSpace(s.Args))
			node := im.newNode("busy", map[string]any{"seconds": sec})
			im.posLink[posKey(exten, i)] = node
			attach(node)
			if i+1 < len(steps) && steps[i+1].App == "Hangup" && !im.consumed[posKey(exten, i+1)] {
				im.consumed[posKey(exten, i+1)] = true
				im.posLink[posKey(exten, i+1)] = node
			}
			chainDone = true

		case "Park":
			node := im.newNode("park", map[string]any{})
			im.posLink[posKey(exten, i)] = node
			attach(node)
			chainDone = true

		case "MixMonitor":
			file, app_ := s.Args, ""
			if c := strings.Index(file, ","); c >= 0 {
				app_ = file[c+1:]
				file = file[:c]
			}
			name := strings.TrimSuffix(strings.TrimPrefix(file, "${UNIQUEID}-"), ".wav")
			node := im.newNode("record", map[string]any{"mode": "start", "name": name, "append": strings.Contains(app_, "a")})
			im.posLink[posKey(exten, i)] = node
			attach(node)
			prevNode, prevPort = node, "out"

		case "StopMixMonitor":
			node := im.newNode("record", map[string]any{"mode": "stop"})
			im.posLink[posKey(exten, i)] = node
			attach(node)
			prevNode, prevPort = node, "out"

		case "Goto":
			gExten, _, gSpec := splitGoto(s.Args, exten)
			if gExten == "" {
				im.warn("Goto(%s) не разобран.", s.Args)
				chainDone = true
				break
			}
			if prevNode != "" {
				im.linkToPos(prevNode, prevPort, gExten, gSpec)
			} else {
				// цепочка-пересылка (например, цифровой exten IVR): целимся в пункт назначения
				if idx2 := im.resolvePos(gExten, gSpec); idx2 >= 0 {
					if node, ok := im.posLink[posKey(gExten, idx2)]; ok {
						if first == "" {
							first = node
						}
						im.posLink[posKey(exten, i)] = node
					} else if t := im.walk(gExten, idx2); t != "" {
						if first == "" {
							first = t
						}
						im.posLink[posKey(exten, i)] = t
					}
				} else {
					im.warn("Goto(%s): цель не найдена.", s.Args)
				}
			}
			chainDone = true

		case "GotoIf":
			cond, gExten, gSpec := splitGotoIf(s.Args, exten)
			node := im.newNode("condition", map[string]any{"expr": cond})
			im.posLink[posKey(exten, i)] = node
			attach(node)
			im.linkToPos(node, "yes", gExten, gSpec)
			// «нет» — следующая позиция; если это Goto — на его цель
			if i+1 < len(steps) && !im.consumed[posKey(exten, i+1)] && steps[i+1].App == "Goto" {
				im.consumed[posKey(exten, i+1)] = true
				nExten, _, nSpec := splitGoto(steps[i+1].Args, exten)
				im.linkToPos(node, "no", nExten, nSpec)
			} else if i+1 < len(steps) {
				im.linkLater(node, "no", exten, i+1)
			} else {
				im.warn("Условие: ветка «нет» ведёт в конец extension.")
			}
			prevNode, prevPort = node, "no"
			chainDone = true

		case "GotoIfTime":
			span, dow, gExten, gSpec := splitGotoIfTime(s.Args, exten)
			start, end := span, span
			if d := strings.Index(span, "-"); d > 0 {
				start, end = span[:d], span[d+1:]
			}
			node := im.newNode("time", map[string]any{"start": start, "end": end, "days": dow})
			im.posLink[posKey(exten, i)] = node
			attach(node)
			im.linkToPos(node, "match", gExten, gSpec)
			if i+1 < len(steps) && !im.consumed[posKey(exten, i+1)] && steps[i+1].App == "Goto" {
				im.consumed[posKey(exten, i+1)] = true
				nExten, _, nSpec := splitGoto(steps[i+1].Args, exten)
				im.linkToPos(node, "nomatch", nExten, nSpec)
			} else if i+1 < len(steps) {
				im.linkLater(node, "nomatch", exten, i+1)
			} else {
				im.warn("Условие времени: ветка «не входит» ведёт в конец extension.")
			}
			prevNode, prevPort = node, "nomatch"
			chainDone = true

		case "Log":
			txt := strings.TrimPrefix(s.Args, "NOTICE, ")
			node := im.newNode("log", map[string]any{"text": txt})
			im.posLink[posKey(exten, i)] = node
			attach(node)
			prevNode, prevPort = node, "out"

		default:
			node := im.newNode("custom", map[string]any{"app": s.App, "args": s.Args})
			im.posLink[posKey(exten, i)] = node
			attach(node)
			prevNode, prevPort = node, "out"
		}
	}
	return first
}

// linkLater связывает с позицией по индексу (для «следующего шага» ветвлений).
func (im *importer) linkLater(from, port, exten string, idx int) {
	steps := im.stepsOf(exten)
	if idx < 0 || idx >= len(steps) {
		return
	}
	if node, ok := im.posLink[posKey(exten, idx)]; ok {
		im.link(from, port, node)
		return
	}
	// помечаем через будущий walk: используем приоритет шага как спецификатор
	im.pending = append(im.pending, pendRef{fromNode: from, port: port, exten: exten, spec: strconv.Itoa(steps[idx].Prio)})
}

func (im *importer) stepsOf(exten string) []DumpStep {
	for ei := range im.ctx.Extens {
		if im.ctx.Extens[ei].Pattern == exten {
			return im.ctx.Extens[ei].Steps
		}
	}
	return nil
}

func (im *importer) mapSet(s DumpStep) string {
	args := s.Args
	eq := strings.Index(args, "=")
	name, val := args, ""
	if eq >= 0 {
		name, val = args[:eq], args[eq+1:]
	}
	switch {
	case strings.HasPrefix(name, "CALLERID("):
		// Set(CALLERID(all)=Имя <7495...>)
		num := val
		nm := ""
		if lt := strings.Index(val, "<"); lt >= 0 {
			nm = strings.TrimSpace(val[:lt])
			num = strings.TrimSuffix(val[lt+1:], ">")
		}
		return im.newNode("setcallerid", map[string]any{"number": num, "name": nm})
	case strings.Contains(val, "${CURL("):
		url := val
		if a := strings.Index(val, "${CURL("); a >= 0 {
			rest := val[a+len("${CURL("):]
			if b := strings.Index(rest, ")}"); b >= 0 {
				url = rest[:b]
			}
		}
		return im.newNode("curl", map[string]any{"url": url})
	default:
		return im.newNode("setvar", map[string]any{"name": name, "value": val})
	}
}

func (im *importer) mapDial(s DumpStep) string {
	parts := strings.SplitN(s.Args, ",", 3)
	target := parts[0]
	timeout := 30
	opts := ""
	if len(parts) > 1 {
		if v, err := strconv.Atoi(strings.TrimSpace(parts[1])); err == nil && v > 0 {
			timeout = v
		}
	}
	if len(parts) > 2 {
		opts = parts[2]
	}
	endpoints := strings.Split(target, "&")
	// транковый набор: PJSIP/<num>@<trunk>
	if len(endpoints) == 1 && strings.Contains(endpoints[0], "@") {
		body := strings.TrimPrefix(endpoints[0], "PJSIP/")
		num := body[:strings.Index(body, "@")]
		trunk := body[strings.Index(body, "@")+1:]
		if num == "${EXTEN}" {
			return im.newNode("outtrunk", map[string]any{"trunk": trunk, "useDialed": true, "timeout": timeout})
		}
		return im.newNode("forward", map[string]any{"number": num, "trunk": trunk, "timeout": timeout})
	}
	members := []any{}
	onlyDigits := true
	for _, ep := range endpoints {
		d := strings.TrimPrefix(ep, "PJSIP/")
		if d == ep || strings.ContainsAny(d, "@") {
			onlyDigits = false
			break
		}
		members = append(members, d)
	}
	if onlyDigits && len(members) > 1 {
		return im.newNode("ringgroup", map[string]any{"mode": "par", "timeout": timeout, "members": members})
	}
	if onlyDigits && len(members) == 1 {
		data := map[string]any{"device": members[0], "timeout": timeout, "options": "tT"}
		if opts != "" && opts != "tT" {
			data["options"] = opts
		}
		return im.newNode("dial", data)
	}
	return im.newNode("custom", map[string]any{"app": "Dial", "args": s.Args})
}

// разборы целей переходов ────────────────────────────────────

func splitGoto(args, curExten string) (exten, ctx, spec string) {
	parts := strings.Split(args, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	switch len(parts) {
	case 1:
		return curExten, "", parts[0]
	case 2:
		return parts[0], "", parts[1]
	default:
		return parts[1], parts[0], parts[2]
	}
}

func splitGotoIf(args, curExten string) (cond, exten, spec string) {
	q := strings.Index(args, "?")
	if q < 0 {
		return args, curExten, ""
	}
	cond = strings.TrimSpace(args[:q])
	cond = strings.TrimPrefix(cond, "$[")
	cond = strings.TrimSuffix(cond, "]")
	exten, _, spec = splitGoto(args[q+1:], curExten)
	return cond, exten, spec
}

func splitGotoIfTime(args, curExten string) (span, dow, exten, spec string) {
	q := strings.Index(args, "?")
	if q < 0 {
		return args, "*", curExten, ""
	}
	times := strings.Split(args[:q], ",")
	span = times[0]
	dow = "*"
	if len(times) > 1 {
		dow = times[1]
	}
	exten, _, spec = splitGoto(args[q+1:], curExten)
	return span, dow, exten, spec
}

var digitExtenRe = regexp.MustCompile(`^([0-9*#]{1,2}|t|i)$`)

func isDigitExten(pat string) bool { return digitExtenRe.MatchString(pat) }

// ── авто-раскладка ──────────────────────────────────────────

func (im *importer) layout() {
	nodes := im.scheme.Nodes
	edges := im.scheme.Edges
	byID := map[string]*Node{}
	for i := range nodes {
		byID[nodes[i].ID] = &nodes[i]
	}
	// BFS от точек входа
	depth := map[string]int{}
	queue := []string{}
	for _, n := range nodes {
		if n.Type == "inbound" || n.Type == "outbound" {
			depth[n.ID] = 0
			queue = append(queue, n.ID)
		}
	}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		for _, e := range edges {
			if e.From.Node == id {
				if _, ok := depth[e.To.Node]; !ok {
					depth[e.To.Node] = depth[id] + 1
					queue = append(queue, e.To.Node)
				}
			}
		}
	}
	maxDepth := 0
	for _, d := range depth {
		if d > maxDepth {
			maxDepth = d
		}
	}
	// осиротевшие — правее всех
	orphanCol := maxDepth + 1
	rowCount := map[int]int{}
	for i := range nodes {
		n := &nodes[i]
		d, ok := depth[n.ID]
		if !ok {
			d = orphanCol
		}
		row := rowCount[d]
		rowCount[d]++
		n.X = 60 + float64(d)*280
		n.Y = 60 + float64(row)*150
	}
}
