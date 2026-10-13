// Преобразование сгенерированных контекстов extensions.conf в команды
// Asterisk CLI "dialplan add extension ... into <ctx>" для записи на станцию
// через AMI. CLI не поддерживает именованные приоритеты — метки разрешаются
// в числовые приоритеты по месту их объявления.
package main

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type cliStep struct {
	exten string
	num   int
	app   string // полностью: NoOp(>>> Ответить)
}

type cliContext struct {
	name  string
	steps []cliStep
}

var (
	reCtx   = regexp.MustCompile(`^\[(.+)\]$`)
	reExten = regexp.MustCompile(`^exten\s+=>\s+([^,]+),(?:\d+|n)(?:\(([^)]*)\))?,?(.*)$`)
	reSame  = regexp.MustCompile(`^same\s+=>\s+n(\(([^)]*)\))?,(.*)$`)
)

// contextsToCLI превращает текст вида
//   [gui-x-in-1]
//   exten => s,1(m_a),NoOp(...)
//   same => n,Answer()
// в команды CLI с числовыми приоритетами и разрешёнными Goto-метками.
func contextsToCLI(text string) (commands []string, contexts []string, err error) {
	type rawStep struct {
		exten string
		label string
		app   string
		first bool // exten => (начало нового extension)
	}
	type rawCtx struct {
		name  string
		steps []rawStep
	}

	// разбор построчно — свой парсер (не splitContexts, т.к. нужны метки)
	raws := []rawCtx{}
	var cur *rawCtx
	flush := func() {
		if cur != nil && cur.name != "general" && cur.name != "globals" {
			raws = append(raws, *cur)
		}
	}
	var includes []string
	for _, line := range strings.Split(text, "\n") {
		trim := strings.TrimSpace(line)
		if m := reCtx.FindStringSubmatch(trim); m != nil {
			flush()
			cur = &rawCtx{name: m[1]}
			continue
		}
		if trim == "" || strings.HasPrefix(trim, ";") {
			continue
		}
		if strings.HasPrefix(trim, "include => ") {
			includes = append(includes, strings.TrimSpace(strings.TrimPrefix(trim, "include => ")))
			continue
		}
		if cur == nil {
			continue
		}
		if m := reExten.FindStringSubmatch(trim); m != nil {
			// приоритет в файле не важен (1 для старта, n для якоря) —
			// числовые приоритеты присваиваем сами по порядку следования
			cur.steps = append(cur.steps, rawStep{exten: strings.TrimSpace(m[1]), label: m[2], app: strings.TrimSpace(m[3]), first: true})
			continue
		}
		if m := reSame.FindStringSubmatch(trim); m != nil {
			// тот же exten, что у предыдущего шага
			ext := ""
			if len(cur.steps) > 0 {
				ext = cur.steps[len(cur.steps)-1].exten
			}
			cur.steps = append(cur.steps, rawStep{exten: ext, label: m[2], app: strings.TrimSpace(m[3])})
			continue
		}
		return nil, nil, fmt.Errorf("не удалось разобрать строку диалплана: %q", trim)
	}
	flush()

	banned := map[string]bool{"general": true, "globals": true}

	commands = []string{}
	contexts = []string{}
	for _, rc := range raws {
		if banned[rc.name] {
			continue
		}
		if len(rc.steps) == 0 {
			continue
		}
		// присваиваем числовые приоритеты в порядке следования, группируя по exten
		num := map[string]int{}
		labelMap := map[string]int{} // key: exten + "\x00" + label
		steps := make([]cliStep, 0, len(rc.steps))
		for _, s := range rc.steps {
			num[s.exten]++
			n := num[s.exten]
			if s.label != "" {
				labelMap[s.exten+"\x00"+s.label] = n
			}
			steps = append(steps, cliStep{exten: s.exten, num: n, app: s.app})
		}
		// резолвим метки внутри приложений: ctx,exten,label → ctx,exten,num
		for i := range steps {
			app := steps[i].app
			for key, n := range labelMap {
				parts := strings.SplitN(key, "\x00", 2)
				needle := rc.name + "," + parts[0] + "," + parts[1] + ")"
				repl := rc.name + "," + parts[0] + "," + strconv.Itoa(n) + ")"
				app = strings.ReplaceAll(app, needle, repl)
			}
			if strings.Contains(app, ",m_") || regexp.MustCompile(`,[a-zA-Z_][a-zA-Z0-9_]*\)$`).MatchString(app) {
				// возможная неразрешённая метка — проверим, что в конце приложения не осталось "ctx,x,label)"
				for _, pref := range []string{"Goto(", "GotoIf(", "GotoIfTime("} {
					if strings.Contains(app, pref) {
						tail := app[strings.LastIndex(app, "(")+1:]
						fields := strings.Split(tail[:len(tail)-1], ",")
						if len(fields) >= 3 {
							last := strings.TrimSpace(fields[len(fields)-1])
							if _, isNum := strconv.Atoi(last); isNum != nil && !strings.Contains(last, "$") && last != "" && !strings.ContainsAny(last, "*?") {
								return nil, nil, fmt.Errorf("контекст %s: не удалось разрешить метку перехода «%s» в строке %q", rc.name, last, app)
							}
						}
					}
				}
			}
			steps[i].app = app
		}

		commands = append(commands, "dialplan remove context "+rc.name)
		for _, s := range steps {
			commands = append(commands,
				fmt.Sprintf("dialplan add extension %s,%d,%s into %s", s.exten, s.num, s.app, rc.name))
		}
		// include => для контекста (gui-internal и т.п.)
		for _, inc := range includes {
			// добавляем include только в тот контекст, который его содержал:
			// includes собраны глобально вне контекста — для простоты прикрепляем
			// к контексту gui-internal, либо игнорируем для прочих
			if rc.name == "gui-internal" {
				commands = append(commands, fmt.Sprintf("dialplan add include %s into %s", inc, rc.name))
			}
		}
		contexts = append(contexts, rc.name)
	}
	sort.Strings(contexts)
	return commands, contexts, nil
}
