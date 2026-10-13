// Компилятор визуальной карты вызова в диалплан Asterisk (extensions.conf/pjsip.conf/queues.conf).
package main

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var safeRe = regexp.MustCompile(`[()\[\]$;,]`)

func safe(s any) string {
	str := fmt.Sprint(s)
	str = safeRe.ReplaceAllString(str, " ")
	return strings.TrimSpace(strings.Join(strings.Fields(str), " "))
}

var titles = map[string]string{
	"inbound": "Входящий вызов", "outbound": "Исходящий маршрут", "answer": "Ответить",
	"playback": "Воспроизвести", "ivr": "IVR-меню", "record": "Запись разговора", "wait": "Пауза",
	"setcallerid": "Изменить CallerID", "setvar": "Переменная", "curl": "HTTP-запрос", "log": "Лог",
	"time": "Условие времени", "condition": "Условие", "dial": "Вызов абонента", "ringgroup": "Группа вызова",
	"queue": "Очередь", "conference": "Конференция", "voicemail": "Голосовая почта", "forward": "Переадресация",
	"outtrunk": "Внешний номер (транк)", "park": "Парковка", "busy": "Сигнал занято", "hangup": "Завершить вызов",
	"custom": "Своя команда",
}

func nodeTitle(n *Node) string {
	if t, ok := titles[n.Type]; ok {
		return t
	}
	return n.Type
}

// ── доступ к данным узла ────────────────────────────────────

func dstr(n *Node, key string) string {
	if n.Data == nil {
		return ""
	}
	v, ok := n.Data[key]
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return fmt.Sprint(t)
	default:
		return fmt.Sprint(v)
	}
}

func dnum(n *Node, key string, def int) int {
	if n.Data == nil {
		return def
	}
	if v, ok := n.Data[key]; ok && v != nil {
		switch t := v.(type) {
		case float64:
			return int(t)
		case int:
			return t
		case int64:
			return int(t)
		case string:
			if i, err := strconv.Atoi(strings.TrimSpace(t)); err == nil {
				return i
			}
		}
	}
	return def
}

func dbool(n *Node, key string) bool {
	if n.Data == nil {
		return false
	}
	if v, ok := n.Data[key]; ok && v != nil {
		if b, ok := v.(bool); ok {
			return b
		}
	}
	return false
}

func dstrArr(n *Node, key string) []string {
	out := []string{}
	if n.Data == nil {
		return out
	}
	v, ok := n.Data[key]
	if !ok || v == nil {
		return out
	}
	if arr, ok := v.([]any); ok {
		for _, it := range arr {
			if s, ok := it.(string); ok && s != "" {
				out = append(out, s)
			}
		}
	}
	return out
}

// ── компиляция схемы ────────────────────────────────────────

type usedSet struct {
	queues  map[string]bool
	trunks  map[string]bool
	devices map[string]bool
}

type schemeResult struct {
	extensions string
	warnings   []string
	used       usedSet
}

type ctxBuilder struct {
	scheme   *Scheme
	byID     map[string]*Node
	edges    []Edge
	warnings *[]string
	used     usedSet

	ctx    string
	exten  string
	lines  []string
	header []string
	first  bool
	// needAnchor — следующая строка цепочки должна быть «exten => <exten>,n,…»
	// (якорь возврата к основному extension после цифровых строк IVR,
	// иначе «same => n» продолжил бы чужой extension — метки стали бы
	// недостижимы для станции).
	needAnchor bool
	emitted    map[string]bool
}

func compileScheme(sc *Scheme, reg *Registry) schemeResult {
	b := &ctxBuilder{
		scheme:   sc,
		byID:     map[string]*Node{},
		edges:    sc.Edges,
		warnings: &[]string{},
		used:     usedSet{map[string]bool{}, map[string]bool{}, map[string]bool{}},
	}
	for i := range sc.Nodes {
		b.byID[sc.Nodes[i].ID] = &sc.Nodes[i]
	}

	var entries []*Node
	for i := range sc.Nodes {
		n := &sc.Nodes[i]
		if n.Type == "inbound" || n.Type == "outbound" {
			entries = append(entries, n)
		}
	}
	if len(entries) == 0 {
		*b.warnings = append(*b.warnings, "В схеме нет точки входа («Входящий вызов» / «Исходящий маршрут») — контекст не будет сгенерирован.")
	}

	sections := []string{}
	for i, e := range entries {
		sections = append(sections, b.emitContext(e, i))
	}

	// недостижимые узлы
	reach := map[string]bool{}
	stack := []string{}
	for _, e := range entries {
		stack = append(stack, e.ID)
	}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if reach[id] {
			continue
		}
		reach[id] = true
		for _, ed := range sc.Edges {
			if ed.From.Node == id {
				stack = append(stack, ed.To.Node)
			}
		}
	}
	for i := range sc.Nodes {
		n := &sc.Nodes[i]
		if !reach[n.ID] {
			*b.warnings = append(*b.warnings, fmt.Sprintf("Блок «%s» не связан ни с одной точкой входа — не попадёт в диалплан.", nodeTitle(n)))
		}
	}

	return schemeResult{
		extensions: strings.Join(sections, "\n") + "\n",
		warnings:   *b.warnings,
		used:       b.used,
	}
}

func (b *ctxBuilder) outTarget(nodeID, port string) *Node {
	for _, e := range b.edges {
		if e.From.Node == nodeID && (port == "" || e.From.Port == port) {
			if n, ok := b.byID[e.To.Node]; ok {
				return n
			}
			return nil
		}
	}
	return nil
}

func labelOf(n *Node) string {
	re := regexp.MustCompile(`[^a-zA-Z0-9_]`)
	return "m_" + re.ReplaceAllString(n.ID, "")
}

func (b *ctxBuilder) emitContext(entry *Node, index int) string {
	isOut := entry.Type == "outbound"
	if b.scheme.StationContext != "" {
		// схема импортирована со станции — сохраняем имя исходного контекста,
		// чтобы выгрузка перезаписала именно его
		b.ctx = b.scheme.StationContext
		if index > 0 {
			b.ctx = fmt.Sprintf("%s-%d", b.scheme.StationContext, index+1)
		}
	} else if isOut {
		b.ctx = fmt.Sprintf("gui-%s-out-%d", b.scheme.ID, index+1)
	} else {
		b.ctx = fmt.Sprintf("gui-%s-in-%d", b.scheme.ID, index+1)
	}
	b.exten = dstr(entry, "did")
	if isOut {
		b.exten = dstr(entry, "pattern")
		if b.exten == "" {
			b.exten = "_X."
		}
	} else if b.exten == "" {
		b.exten = "s"
	}
	b.lines = []string{}
	b.first = true
	b.emitted = map[string]bool{}
	kind := "входящий вызов"
	if isOut {
		kind = "исходящий маршрут"
	}
	b.header = []string{
		"",
		"; ──────────────────────────────────────────────────────────────",
		fmt.Sprintf("; Схема: %s  ·  точка входа #%d (%s)", safe(b.scheme.Name), index+1, kind),
		"; ──────────────────────────────────────────────────────────────",
		"[" + b.ctx + "]",
	}
	b.emitNode(entry)
	return strings.Join(append(b.header, b.lines...), "\n")
}

func (b *ctxBuilder) push(action, label string) {
	var tag string
	switch {
	case b.first:
		tag = "exten => " + b.exten + ",1"
	case b.needAnchor:
		tag = "exten => " + b.exten + ",n"
		b.needAnchor = false
	default:
		tag = "same => n"
	}
	if label != "" {
		b.lines = append(b.lines, fmt.Sprintf("%s(%s),%s", tag, label, action))
	} else {
		b.lines = append(b.lines, fmt.Sprintf("%s,%s", tag, action))
	}
	b.first = false
}

func (b *ctxBuilder) sayNode(n *Node) {
	b.push("NoOp(>>> "+safe(nodeTitle(n))+")", labelOf(n))
}

func (b *ctxBuilder) gotoNode(n *Node) {
	b.push(fmt.Sprintf("Goto(%s,%s,%s)", b.ctx, b.exten, labelOf(n)), "")
}

func (b *ctxBuilder) next(n *Node, port string) *Node {
	t := b.outTarget(n.ID, port)
	if t == nil {
		if port == "" {
			port = "out"
		}
		t = b.outTarget(n.ID, port)
	}
	if t == nil {
		b.push("Hangup()", "")
		*b.warnings = append(*b.warnings, fmt.Sprintf("Блок «%s»: выход не подключён — ветка завершена Hangup().", nodeTitle(n)))
		return nil
	}
	return t
}

func (b *ctxBuilder) warn(format string, args ...any) {
	*b.warnings = append(*b.warnings, fmt.Sprintf(format, args...))
}

// emitNode — линейный проход по цепочке блоков; ветвления раскручиваются рекурсивно.
func (b *ctxBuilder) emitNode(start *Node) {
	cur := start
	for cur != nil {
		if b.emitted[cur.ID] {
			b.gotoNode(cur)
			return
		}
		b.emitted[cur.ID] = true
		dd := func(k string) string { return dstr(cur, k) }
		jmp := fmt.Sprintf("%s,%s,", b.ctx, b.exten)

		b.sayNode(cur)
		switch cur.Type {
		case "inbound":
			if dd("trunk") != "" {
				b.push("NoOp(Транк: "+safe(dd("trunk"))+")", "")
			}
			b.push("Set(CHANNEL(language)=ru)", "")
			if dbool(cur, "recordAll") {
				b.push("Set(__REC_FILE=/var/spool/asterisk/monitor/${STRFTIME(${EPOCH},,%Y%m%d-%H%M%S)}-${CALLERID(num)}.wav)", "")
			}
			cur = b.next(cur, "out")

		case "outbound":
			b.push("Set(__OUTNUM=${EXTEN})", "")
			cur = b.next(cur, "out")

		case "answer":
			delay := dnum(cur, "delay", 0)
			if delay > 0 {
				b.push(fmt.Sprintf("Answer(%d)", delay*1000), "")
			} else {
				b.push("Answer()", "")
			}
			cur = b.next(cur, "out")

		case "playback":
			g := dd("greeting")
			if g == "" {
				g = "hello"
			}
			if dbool(cur, "interruptible") {
				b.push("Background("+safe(g)+")", "")
			} else {
				b.push("Playback("+safe(g)+")", "")
			}
			cur = b.next(cur, "out")

		case "record":
			if dd("mode") == "stop" {
				b.push("StopMixMonitor()", "")
			} else {
				name := dd("name")
				if name == "" {
					name = "call"
				}
				app := ""
				if dbool(cur, "append") {
					app = "a"
				}
				b.push(fmt.Sprintf("MixMonitor(${UNIQUEID}-%s.wav,%s)", safe(name), app), "")
			}
			cur = b.next(cur, "out")

		case "wait":
			sec := dnum(cur, "seconds", 1)
			if sec <= 0 {
				sec = 1
			}
			b.push(fmt.Sprintf("Wait(%d)", sec), "")
			cur = b.next(cur, "out")

		case "setcallerid":
			num := dd("number")
			if num == "" {
				num = "${CALLERID(num)}"
			}
			name := dd("name")
			if name == "" {
				name = "${CALLERID(name)}"
			}
			b.push(fmt.Sprintf("Set(CALLERID(all)=%s <%s>)", safe(name), safe(num)), "")
			cur = b.next(cur, "out")

		case "setvar":
			nm := dd("name")
			if nm == "" {
				nm = "MYVAR"
			}
			b.push(fmt.Sprintf("Set(%s=%s)", safe(nm), safe(dd("value"))), "")
			cur = b.next(cur, "out")

		case "log":
			txt := dd("text")
			if txt == "" {
				txt = "marker"
			}
			b.push("Log(NOTICE, "+safe(txt)+")", "")
			cur = b.next(cur, "out")

		case "curl":
			url := strings.ReplaceAll(dd("url"), "(", "")
			url = strings.ReplaceAll(url, ")", "")
			if url == "" {
				url = "http://"
			}
			b.push("Set(CURLRES=${CURL(" + url + ")})", "")
			cur = b.next(cur, "out")

		case "custom":
			app := dd("app")
			if app == "" {
				b.warn("«Своя команда»: не указано приложение Asterisk.")
				b.push("NoOp(Своя команда без приложения)", "")
			} else {
				b.push(safe(app)+"("+dd("args")+")", "")
			}
			cur = b.next(cur, "out")

		case "ivr":
			to := dnum(cur, "timeout", 10)
			greeting := dd("greeting")
			if greeting == "" {
				greeting = "demo-congrats"
			}
			b.push("Background("+safe(greeting)+")", "")
			b.push(fmt.Sprintf("WaitExten(%d)", to), "")
			b.push("Hangup()", "")
			keys := dstrArr(cur, "keys")
			for _, k := range keys {
				if t := b.outTarget(cur.ID, "k"+k); t != nil {
					b.lines = append(b.lines, fmt.Sprintf("exten => %s,1,Goto(%s,%s,%s)", k, b.ctx, b.exten, labelOf(t)))
				} else {
					b.lines = append(b.lines,
						fmt.Sprintf("exten => %s,1,Playback(invalid)", k),
						fmt.Sprintf("same => n,Goto(%s,%s,%s)", b.ctx, b.exten, labelOf(cur)))
					b.warn("IVR: клавиша «%s» не подключена — повтор меню.", k)
				}
			}
			var tT, tI *Node
			if dbool(cur, "useT") {
				tT = b.outTarget(cur.ID, "kt")
			}
			if tT != nil {
				b.lines = append(b.lines, fmt.Sprintf("exten => t,1,Goto(%s,%s,%s)", b.ctx, b.exten, labelOf(tT)))
			} else {
				b.lines = append(b.lines, "exten => t,1,Hangup()")
			}
			if dbool(cur, "useI") {
				tI = b.outTarget(cur.ID, "ki")
			}
			if tI != nil {
				b.lines = append(b.lines, fmt.Sprintf("exten => i,1,Goto(%s,%s,%s)", b.ctx, b.exten, labelOf(tI)))
			} else {
				b.lines = append(b.lines,
					"exten => i,1,Playback(invalid)",
					fmt.Sprintf("same => n,Goto(%s,%s,%s)", b.ctx, b.exten, labelOf(cur)))
			}
			// после цифровых extension-строк возвращаемся к основному extension —
			// следующая строка цепочки должна начинаться с «exten => <exten>,n»
			b.needAnchor = true
			for _, k := range keys {
				if t := b.outTarget(cur.ID, "k"+k); t != nil && !b.emitted[t.ID] {
					b.emitNode(t)
				}
			}
			if tT != nil && !b.emitted[tT.ID] {
				b.emitNode(tT)
			}
			if tI != nil && !b.emitted[tI.ID] {
				b.emitNode(tI)
			}
			return

		case "time":
			start, end := dd("start"), dd("end")
			if start == "" {
				start = "09:00"
			}
			if end == "" {
				end = "18:00"
			}
			dow := dd("days")
			if dow == "" {
				dow = "mon-fri"
			}
			tYes := b.outTarget(cur.ID, "match")
			tNo := b.outTarget(cur.ID, "nomatch")
			if tYes == nil && tNo == nil {
				b.warn("«Условие времени»: оба выхода не подключены — ветка завершена Hangup().")
				b.push("Hangup()", "")
				return
			}
			span := fmt.Sprintf("%s-%s,%s,*,*", start, end, dow)
			if tYes != nil && tNo != nil {
				b.push(fmt.Sprintf("GotoIfTime(%s?%s%s)", span, jmp, labelOf(tYes)), "")
				b.push(fmt.Sprintf("Goto(%s%s)", jmp, labelOf(tNo)), "")
			} else if tYes != nil {
				b.push(fmt.Sprintf("GotoIfTime(%s?%s%s)", span, jmp, labelOf(tYes)), "")
				b.push("Hangup()", "")
				b.warn("«Условие времени»: выход «не входит» не подключён — ночью вызов завершится Hangup().")
			} else {
				fb := labelOf(cur) + "_th"
				b.push(fmt.Sprintf("GotoIfTime(%s?%s%s)", span, jmp, fb), "")
				b.push(fmt.Sprintf("Goto(%s%s)", jmp, labelOf(tNo)), "")
				b.push("Hangup()", fb)
				b.warn("«Условие времени»: выход «входит» не подключён — по совпадению вызов завершится Hangup().")
			}
			if tYes != nil && !b.emitted[tYes.ID] {
				b.emitNode(tYes)
			}
			if tNo != nil && !b.emitted[tNo.ID] {
				b.emitNode(tNo)
			}
			return

		case "condition":
			expr := dd("expr")
			expr = strings.ReplaceAll(expr, "(", "")
			expr = strings.ReplaceAll(expr, ")", "")
			if expr == "" {
				expr = "1=1"
			}
			tYes := b.outTarget(cur.ID, "yes")
			tNo := b.outTarget(cur.ID, "no")
			if tYes == nil && tNo == nil {
				b.warn("«Условие»: оба выхода не подключены — ветка завершена Hangup().")
				b.push("Hangup()", "")
				return
			}
			if tYes != nil && tNo != nil {
				b.push(fmt.Sprintf("GotoIf($[%s]?%s%s)", expr, jmp, labelOf(tYes)), "")
				b.push(fmt.Sprintf("Goto(%s%s)", jmp, labelOf(tNo)), "")
			} else if tYes != nil {
				b.push(fmt.Sprintf("GotoIf($[%s]?%s%s)", expr, jmp, labelOf(tYes)), "")
				b.push("Hangup()", "")
				b.warn("«Условие»: выход «нет» не подключён — вызов завершится Hangup().")
			} else {
				fb := labelOf(cur) + "_th"
				b.push(fmt.Sprintf("GotoIf($[%s]?%s%s)", expr, jmp, fb), "")
				b.push(fmt.Sprintf("Goto(%s%s)", jmp, labelOf(tNo)), "")
				b.push("Hangup()", fb)
				b.warn("«Условие»: выход «да» не подключён — по истине вызов завершится Hangup().")
			}
			if tYes != nil && !b.emitted[tYes.ID] {
				b.emitNode(tYes)
			}
			if tNo != nil && !b.emitted[tNo.ID] {
				b.emitNode(tNo)
			}
			return

		case "dial":
			dev := strings.TrimSpace(dd("device"))
			if dev == "" {
				b.warn("«Вызов абонента»: не выбран номер устройства.")
			} else {
				b.used.devices[dev] = true
			}
			timeout := dnum(cur, "timeout", 30)
			opts := dd("options")
			if opts == "" {
				opts = "tT"
			}
			target := safe(dev)
			if target == "" {
				target = "UNDEFINED"
			}
			b.push(fmt.Sprintf("Dial(PJSIP/%s,%d,%s)", target, timeout, opts), "")
			cur = b.next(cur, "out")

		case "ringgroup":
			members := dstrArr(cur, "members")
			if len(members) == 0 {
				b.warn("«Группа вызова»: пустой список участников.")
			}
			for _, m := range members {
				b.used.devices[m] = true
			}
			t := dnum(cur, "timeout", 25)
			if dd("mode") == "seq" {
				for _, m := range members {
					b.push(fmt.Sprintf("Dial(PJSIP/%s,%d,tT)", safe(m), t), "")
				}
			} else {
				parts := []string{}
				for _, m := range members {
					parts = append(parts, "PJSIP/"+safe(m))
				}
				b.push(fmt.Sprintf("Dial(%s,%d,tT)", strings.Join(parts, "&"), t), "")
			}
			cur = b.next(cur, "out")

		case "queue":
			name := dd("name")
			if name == "" {
				b.warn("«Очередь»: не указано имя очереди.")
			} else {
				b.used.queues[name] = true
			}
			opts := dd("options")
			if opts == "" {
				opts = "t"
			}
			qn := safe(name)
			if qn == "" {
				qn = "support"
			}
			t := dnum(cur, "timeout", 0)
			ts := ""
			if t > 0 {
				ts = strconv.Itoa(t)
			}
			b.push(fmt.Sprintf("Queue(%s,%s,,,%s)", qn, opts, ts), "")
			cur = b.next(cur, "out")

		case "conference":
			room := dd("room")
			if room == "" {
				b.warn("«Конференция»: не указан номер комнаты.")
				room = "900"
			}
			pin := dd("pin")
			if pin != "" {
				b.push(fmt.Sprintf("ConfBridge(%s,%s)", safe(room), safe(pin)), "")
			} else {
				b.push(fmt.Sprintf("ConfBridge(%s)", safe(room)), "")
			}
			cur = b.next(cur, "out")

		case "voicemail":
			box := dd("box")
			if box == "" {
				b.warn("«Голосовая почта»: не указан ящик.")
				box = "100"
			}
			vctx := dd("context")
			if vctx == "" {
				vctx = "default"
			}
			mode := dd("mode")
			if mode == "" {
				mode = "u"
			}
			b.push(fmt.Sprintf("VoiceMail(%s@%s,%s)", safe(box), safe(vctx), safe(mode)), "")
			if dbool(cur, "exit") {
				cur = b.next(cur, "out")
			} else {
				b.push("Hangup()", "")
				cur = nil
			}

		case "forward":
			num := strings.TrimSpace(dd("number"))
			trunk := strings.TrimSpace(dd("trunk"))
			if num == "" {
				b.warn("«Переадресация»: не задан номер назначения.")
			}
			if trunk == "" {
				b.warn("«Переадресация»: не выбран транк.")
			} else {
				b.used.trunks[trunk] = true
			}
			dest := num
			if dest == "$DIALED" {
				dest = "${EXTEN}"
			} else {
				dest = safe(dest)
			}
			if dest == "" {
				dest = "UNKNOWN"
			}
			tr := safe(trunk)
			if tr == "" {
				tr = "trunk"
			}
			b.push(fmt.Sprintf("Dial(PJSIP/%s@%s,%d,tT)", dest, tr, dnum(cur, "timeout", 30)), "")
			cur = b.next(cur, "out")

		case "outtrunk":
			trunk := strings.TrimSpace(dd("trunk"))
			if trunk == "" {
				b.warn("«Внешний номер (транк)»: транк не выбран.")
			} else {
				b.used.trunks[trunk] = true
			}
			dest := "${EXTEN}"
			useDialed := true
			if v, ok := cur.Data["useDialed"]; ok {
				if vb, ok := v.(bool); ok {
					useDialed = vb
				}
			}
			if !useDialed {
				dest = safe(dd("number"))
			}
			tr := safe(trunk)
			if tr == "" {
				tr = "trunk"
			}
			b.push(fmt.Sprintf("Dial(PJSIP/%s@%s,%d,tT)", dest, tr, dnum(cur, "timeout", 60)), "")
			cur = b.next(cur, "out")

		case "park":
			b.push("Park()", "")
			return

		case "busy":
			sec := dnum(cur, "seconds", 0)
			if sec > 0 {
				b.push(fmt.Sprintf("Busy(%d)", sec), "")
			} else {
				b.push("Busy()", "")
			}
			b.push("Hangup()", "")
			return

		case "hangup":
			cause := dd("cause")
			if cause != "" {
				b.push("Hangup("+safe(cause)+")", "")
			} else {
				b.push("Hangup()", "")
			}
			return

		default:
			b.push("NoOp(Неизвестный блок: "+safe(cur.Type)+")", "")
			b.warn("Тип блока «%s» неизвестен компилятору — пропущен как NoOp.", cur.Type)
			cur = b.next(cur, "out")
		}
	}
}

// ── pjsip.conf ──────────────────────────────────────────────

func compilePjsip(reg *Registry) string {
	out := []string{
		"; ══════════════════════════════════════════════════════════════",
		"; pjsip.conf — сгенерировано GUIPBX",
		"; Подключите: #include этого файла в /etc/asterisk/pjsip.conf",
		"; ══════════════════════════════════════════════════════════════",
		"",
		"[transport-udp]",
		"type=transport",
		"protocol=udp",
		"bind=0.0.0.0:5060",
		"",
	}
	for _, dev := range reg.Devices {
		ctx := dev.Context
		if ctx == "" {
			ctx = "gui-internal"
		}
		out = append(out,
			fmt.Sprintf("; ----- Абонент %s · %s -----", dev.Number, safe(dev.Name)),
			"["+dev.Number+"]",
			"type=endpoint",
			"context="+ctx,
			"disallow=all",
			"allow=ulaw,alaw,opus",
			"auth="+dev.Number,
			"aors="+dev.Number,
			"",
			"["+dev.Number+"]",
			"type=auth",
			"auth_type=userpass",
			"username="+dev.Number,
			"password="+dev.Secret,
			"",
			"["+dev.Number+"]",
			"type=aor",
			"max_contacts=1",
			"",
		)
	}
	for _, tr := range reg.Trunks {
		name := safe(tr.Name)
		if name == "" {
			name = "trunk"
		}
		out = append(out, fmt.Sprintf("; ----- Транк «%s» · %s -----", name, safe(tr.Host)))
		port := ""
		if tr.Port != 0 && tr.Port != 5060 {
			port = fmt.Sprintf(":%d", tr.Port)
		}
		if tr.Register {
			out = append(out,
				"["+name+"-reg]",
				"type=registration",
				"transport=transport-udp",
				"outbound_auth="+name,
				fmt.Sprintf("server_uri=sip:%s%s", tr.Host, port),
				fmt.Sprintf("client_uri=sip:%s@%s", tr.Username, tr.Host),
				"retry_interval=60",
				"",
			)
		}
		if tr.Username != "" {
			out = append(out,
				"["+name+"]",
				"type=auth",
				"auth_type=userpass",
				"username="+tr.Username,
				"password="+tr.Password,
				"",
			)
		}
		out = append(out,
			"["+name+"]",
			"type=aor",
			fmt.Sprintf("contact=sip:%s%s", tr.Host, port),
			"",
			"["+name+"]",
			"type=endpoint",
			"context="+defaultStr(tr.Context, "gui-demo1-in-1"),
			"disallow=all",
			"allow=ulaw,alaw",
			"aors="+name,
		)
		if tr.Username != "" {
			out = append(out, "outbound_auth="+name)
		}
		out = append(out, "from_user="+tr.Username, "from_domain="+tr.Host, "")
		if tr.Inbound {
			out = append(out,
				"["+name+"]",
				"type=identify",
				"endpoint="+name,
				"match="+tr.Host,
				"",
			)
		}
	}
	return strings.Join(out, "\n")
}

func defaultStr(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

// ── внутренний контекст + очереди ───────────────────────────

func compileInternal(reg *Registry, schemes []*Scheme) string {
	lines := []string{
		"; Внутренние звонки между зарегистрированными абонентами",
		"[gui-internal]",
	}
	for _, d := range reg.Devices {
		lines = append(lines, fmt.Sprintf("exten => %s,1,Dial(PJSIP/%s,30,tT)", d.Number, d.Number))
	}
	if len(reg.Devices) > 0 {
		lines = append(lines, "same => n,Hangup()")
	}
	outIncludes := []string{}
	for _, sc := range schemes {
		idx := 0
		for i := range sc.Nodes {
			if sc.Nodes[i].Type == "outbound" {
				idx++
				outIncludes = append(outIncludes, fmt.Sprintf("include => gui-%s-out-%d", sc.ID, idx))
			}
		}
	}
	if len(outIncludes) > 0 {
		lines = append(lines, "", "; Исходящие маршруты, нарисованные на картах:")
		lines = append(lines, outIncludes...)
	}
	return strings.Join(lines, "\n") + "\n"
}

func compileQueues(names []string, reg *Registry) string {
	if len(names) == 0 {
		return ""
	}
	sort.Strings(names)
	out := []string{"; queues.conf — очереди, использованные в схемах GUIPBX", "[general]", "persistentmembers = yes", ""}
	for _, q := range names {
		out = append(out, "["+q+"]", "strategy = ringall", "timeout = 15", "retry = 5", "maxlen = 0")
		for _, d := range reg.Devices {
			out = append(out, "member => PJSIP/"+d.Number)
		}
		out = append(out, "")
	}
	return strings.Join(out, "\n")
}

// ── проект целиком ──────────────────────────────────────────

type projectResult struct {
	Extensions string   `json:"extensions"`
	Pjsip      string   `json:"pjsip"`
	Queues     string   `json:"queues,omitempty"`
	Warnings   []string `json:"warnings"`
}

func compileProject(schemes []*Scheme, reg *Registry) projectResult {
	parts := []string{
		"; ╔══════════════════════════════════════════════════════════════╗",
		"; ║  extensions_gui.conf — сгенерировано GUIPBX " + time.Now().UTC().Format(time.RFC3339) + " ║",
		"; ║  НЕ редактируйте вручную — файл перезаписывается из редактора ║",
		"; ╚══════════════════════════════════════════════════════════════╝",
		"",
		"[general]",
		"[globals]",
	}
	warnings := []string{}
	queueNames := map[string]bool{}
	usedTrunks := map[string]bool{}
	usedDevices := map[string]bool{}
	for _, sc := range schemes {
		r := compileScheme(sc, reg)
		for _, w := range r.warnings {
			warnings = append(warnings, "["+sc.Name+"] "+w)
		}
		for q := range r.used.queues {
			queueNames[q] = true
		}
		for t := range r.used.trunks {
			usedTrunks[t] = true
		}
		for d := range r.used.devices {
			usedDevices[d] = true
		}
		parts = append(parts, r.extensions)
	}
	parts = append(parts, compileInternal(reg, schemes))

	regTrunks := map[string]bool{}
	for _, t := range reg.Trunks {
		regTrunks[t.Name] = true
	}
	for t := range usedTrunks {
		if !regTrunks[t] {
			warnings = append(warnings, fmt.Sprintf("Используется транк «%s», отсутствующий в реестре транков.", t))
		}
	}
	regDevs := map[string]bool{}
	for _, d := range reg.Devices {
		regDevs[d.Number] = true
	}
	for d := range usedDevices {
		if !regDevs[d] {
			warnings = append(warnings, fmt.Sprintf("Используется абонент «%s», отсутствующий в реестре устройств.", d))
		}
	}

	qSorted := []string{}
	for q := range queueNames {
		qSorted = append(qSorted, q)
	}

	return projectResult{
		Extensions: strings.Join(parts, "\n"),
		Pjsip:      compilePjsip(reg),
		Queues:     compileQueues(qSorted, reg),
		Warnings:   warnings,
	}
}
