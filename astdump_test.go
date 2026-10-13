package main

import (
	"strings"
	"testing"
)

// Дамп, который станция отдаст для контекста, выгруженного GUIPBX через CLI
// (именованные приоритеты сплющены в числовые — как и происходит в реальности).
const demoDump = `
[ Context 'gui-demo1-in-1' created by 'pbx_config' ]
  's' =>            1. NoOp(>>> Входящий вызов)            [pbx_config]
                     2. NoOp(Транк: provider)              [pbx_config]
                     3. Set(CHANNEL(language)=ru)          [pbx_config]
                     4. NoOp(>>> Ответить)                 [pbx_config]
                     5. Answer()                           [pbx_config]
                     6. NoOp(>>> Воспроизвести)            [pbx_config]
                     7. Playback(hello)                    [pbx_config]
                     8. NoOp(>>> IVR-меню)                 [pbx_config]
                     9. Background(demo-congrats)          [pbx_config]
                    10. WaitExten(10)                      [pbx_config]
                    11. Hangup()                           [pbx_config]
                    12. NoOp(>>> Вызов абонента)           [pbx_config]
                    13. Dial(PJSIP/100,25,tT)              [pbx_config]
                    14. NoOp(>>> Голосовая почта)          [pbx_config]
                    15. VoiceMail(100@default,u)           [pbx_config]
                    16. Hangup()                           [pbx_config]
                    17. NoOp(>>> Группа вызова)            [pbx_config]
                    18. Dial(PJSIP/100&PJSIP/101,30,tT)    [pbx_config]
                    19. NoOp(>>> Голосовая почта)          [pbx_config]
                    20. VoiceMail(101@default,u)           [pbx_config]
                    21. Hangup()                           [pbx_config]
                    22. NoOp(>>> Переадресация)            [pbx_config]
                    23. Dial(PJSIP/+79990001122@provider,30,tT) [pbx_config]
                    24. NoOp(>>> Завершить вызов)          [pbx_config]
                    25. Hangup()                           [pbx_config]
                    26. NoOp(>>> Воспроизвести)            [pbx_config]
                    27. Playback(goodbye)                  [pbx_config]
                    28. Goto(gui-demo1-in-1,s,24)          [pbx_config]
  '1' =>            1. Goto(gui-demo1-in-1,s,12)           [pbx_config]
  '2' =>            1. Goto(gui-demo1-in-1,s,17)           [pbx_config]
  '0' =>            1. Goto(gui-demo1-in-1,s,22)           [pbx_config]
  't' =>            1. Goto(gui-demo1-in-1,s,26)           [pbx_config]
  'i' =>            1. Playback(invalid)                   [pbx_config]
                     2. Goto(gui-demo1-in-1,s,8)            [pbx_config]

-= 6 extensions (33 priorities) in 1 context. =-
`

const foreignDump = `
[ Context 'from-internal' created by 'pbx_config' ]
  '100' => hint: PJSIP/100&PJSIP/Custom:100        [pbx_config]
  '600' =>           1. AGI(agi://127.0.0.1/test)      [pbx_config]
                     2. Playback(demo-thanks)          [pbx_config]
                     3. Hangup()                       [pbx_config]
  Include in context: 'parkedcalls'             [pbx_config]

-= 2 extensions (3 priorities) in 1 context. =-
`

func TestParseDialplanShow(t *testing.T) {
	ctxs := parseDialplanShow(demoDump)
	if len(ctxs) != 1 {
		t.Fatalf("ожидался 1 контекст, получено %d", len(ctxs))
	}
	c := ctxs[0]
	if c.Name != "gui-demo1-in-1" {
		t.Errorf("имя контекста: %q", c.Name)
	}
	if c.extenCount() != 6 {
		t.Errorf("extensions: %d (ожидалось 6)", c.extenCount())
	}
	if got := c.Extens[0].Steps[0].App; got != "NoOp" {
		t.Errorf("шаг 1: %q", got)
	}
	if got := c.Extens[0].Steps[28-1].App; got != "Goto" {
		t.Errorf("шаг 28: %q", got)
	}
}

func TestImportDemoDump(t *testing.T) {
	ctxs := parseDialplanShow(demoDump)
	sc, warnings := importContext(ctxs[0], "testimp", "Тест")

	counts := map[string]int{}
	byID := map[string]*Node{}
	for i := range sc.Nodes {
		counts[sc.Nodes[i].Type]++
		byID[sc.Nodes[i].ID] = &sc.Nodes[i]
	}
	expectNodes := map[string]int{
		"inbound": 1, "answer": 1, "playback": 3, "ivr": 1, "dial": 1,
		"ringgroup": 1, "voicemail": 2, "forward": 1, "hangup": 1,
	}
	for typ, want := range expectNodes {
		if counts[typ] != want {
			t.Errorf("блоков типа %s: %d, ожидалось %d (warnings: %v)", typ, counts[typ], want, warnings)
		}
	}
	if len(sc.Edges) != 13 {
		t.Errorf("edge count: %d, ожидалось 13 (warnings: %v)", len(sc.Edges), warnings)
	}
	if len(warnings) != 0 {
		t.Errorf("нежелательные предупреждения: %v", warnings)
	}

	// IVR: клавиши и связи
	var ivr *Node
	for i := range sc.Nodes {
		if sc.Nodes[i].Type == "ivr" {
			ivr = &sc.Nodes[i]
		}
	}
	if ivr == nil {
		t.Fatal("IVR не найден")
	}
	keys := dstrArr(ivr, "keys")
	if strings.Join(keys, ",") != "0,1,2" {
		t.Errorf("клавиши IVR: %v", keys)
	}
	if !dbool(ivr, "useT") || !dbool(ivr, "useI") {
		t.Errorf("useT/useI: %v/%v", dbool(ivr, "useT"), dbool(ivr, "useI"))
	}

	portOf := func(port string) *Node {
		for _, e := range sc.Edges {
			if e.From.Node == ivr.ID && e.From.Port == port {
				return byID[e.To.Node]
			}
		}
		return nil
	}
	if n := portOf("k1"); n == nil || n.Type != "dial" {
		t.Errorf("k1 ведёт не на dial: %+v", n)
	}
	if n := portOf("k2"); n == nil || n.Type != "ringgroup" {
		t.Errorf("k2 ведёт не на ringgroup: %+v", n)
	}
	if n := portOf("k0"); n == nil || n.Type != "forward" {
		t.Errorf("k0 ведёт не на forward: %+v", n)
	}
	if n := portOf("kt"); n == nil || n.Type != "playback" {
		t.Errorf("kt ведёт не на playback: %+v", n)
	}

	// параметры блоков
	if d := byID[portOf("k1").ID]; dstr(d, "device") != "100" || dnum(d, "timeout", 0) != 25 {
		t.Errorf("dial: %v", d.Data)
	}
	var rg *Node
	for i := range sc.Nodes {
		if sc.Nodes[i].Type == "ringgroup" {
			rg = &sc.Nodes[i]
		}
	}
	if m := dstrArr(rg, "members"); strings.Join(m, ",") != "100,101" {
		t.Errorf("ringgroup members: %v", m)
	}
	if f := portOf("k0"); dstr(f, "number") != "+79990001122" || dstr(f, "trunk") != "provider" {
		t.Errorf("forward: %v", f.Data)
	}

	// раскладка: глубина растёт слева направо
	if !(portOf("k1").X > ivr.X && ivr.X > 60) {
		t.Errorf("раскладка: X ivr=%v dial=%v", ivr.X, portOf("k1").X)
	}
}

func TestImportForeign(t *testing.T) {
	ctxs := parseDialplanShow(foreignDump)
	if len(ctxs) != 1 {
		t.Fatalf("контексты: %d", len(ctxs))
	}
	if ctxs[0].extenCount() != 1 { // hint-строка '100' отброшена
		t.Fatalf("extens: %d", ctxs[0].extenCount())
	}
	sc, warnings := importContext(ctxs[0], "imp2", "Чужой")
	types := []string{}
	for _, n := range sc.Nodes {
		types = append(types, n.Type)
	}
	joined := strings.Join(types, ",")
	for _, want := range []string{"inbound", "custom", "playback", "hangup"} {
		if !strings.Contains(joined, want) {
			t.Errorf("нет блока %s среди %v (warnings %v)", want, joined, warnings)
		}
	}
}

// Круговой тест: схема → диалплан → CLI-команды → (станция) → дамп → схема.
func TestRoundTrip(t *testing.T) {
	reg := demoRegistry()
	sr := compileScheme(demoScheme(), reg)
	commands, _, err := contextsToCLI(sr.extensions)
	if err != nil {
		t.Fatalf("cli: %v", err)
	}
	// эмулируем станцию: "выполняем" команды add extension и заново дампим
	steps := map[string][]string{} // ctx -> строки "exten,prio,app"
	order := []string{}
	for _, c := range commands {
		parts := strings.Split(c, " ")
		if len(parts) >= 3 && parts[0] == "dialplan" && parts[1] == "remove" {
			continue
		}
		if strings.HasPrefix(c, "dialplan add extension ") {
			rest := strings.TrimPrefix(c, "dialplan add extension ")
			inIdx := strings.LastIndex(rest, " into ")
			if inIdx < 0 {
				t.Fatalf("команда без into: %q", c)
			}
			ctx := rest[inIdx+6:]
			if _, ok := steps[ctx]; !ok {
				order = append(order, ctx)
			}
			steps[ctx] = append(steps[ctx], rest[:inIdx])
		}
	}
	var dump strings.Builder
	for _, ctx := range order {
		dump.WriteString("\n[ Context '" + ctx + "' created by 'pbx_config' ]\n")
		byExten := map[string][]string{}
		extOrder := []string{}
		for _, s := range steps[ctx] {
			c1 := strings.Index(s, ",")
			c2 := strings.Index(s[c1+1:], ",")
			if c1 < 0 || c2 < 0 {
				t.Fatalf("строка не разобрана: %q", s)
			}
			ext := s[:c1]
			rest := s[c1+1:]
			prio := rest[:c2]
			app := rest[c2+1:]
			if _, ok := byExten[ext]; !ok {
				extOrder = append(extOrder, ext)
			}
			byExten[ext] = append(byExten[ext], prio+"|"+app)
		}
		for _, ext := range extOrder {
			for i, pa := range byExten[ext] {
				pipe := strings.Index(pa, "|")
				prio, app := pa[:pipe], pa[pipe+1:]
				if i == 0 {
					dump.WriteString("  '" + ext + "' => " + prio + ". " + app + "\n")
				} else {
					dump.WriteString("              " + prio + ". " + app + "\n")
				}
			}
		}
	}
	dump.WriteString("\n-= done =-\n")

	ctxs := parseDialplanShow(dump.String())
	if len(ctxs) != 1 {
		t.Fatalf("парс эмулированного дампа: %d контекстов\n%s", len(ctxs), dump.String())
	}
	sc, warnings := importContext(ctxs[0], "roundtrip", "Круговой")
	counts := map[string]int{}
	for _, n := range sc.Nodes {
		counts[n.Type]++
	}
	if counts["ivr"] != 1 || counts["voicemail"] != 2 || counts["hangup"] != 1 || counts["ringgroup"] != 1 {
		t.Errorf("круговой импорт исказил структуру: %v, warnings: %v", counts, warnings)
	}

	// и обратно: новая схема должна компилироваться без ошибок
	sr2 := compileScheme(sc, reg)
	if !strings.Contains(sr2.extensions, "Dial(PJSIP/100&PJSIP/101,30,tT)") {
		t.Errorf("повторная компиляция потеряла ringgroup")
	}
}
