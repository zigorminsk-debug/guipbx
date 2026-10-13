package main

import (
	"strings"
	"testing"
)

func TestDemoCompile(t *testing.T) {
	reg := demoRegistry()
	sc := demoScheme()
	r := compileScheme(sc, reg)
	ext := r.extensions

	expected := []string{
		"[gui-demo1-in-1]",
		"exten => s,1",
		"Answer()",
		"Playback(hello)",
		"Background(demo-congrats)",
		"WaitExten(10)",
		"exten => 1,1,Goto(gui-demo1-in-1,s,m_n_dial1)",
		"exten => 2,1,Goto(gui-demo1-in-1,s,m_n_rg)",
		"exten => 0,1,Goto(gui-demo1-in-1,s,m_n_fwd)",
		"exten => t,1,Goto(gui-demo1-in-1,s,m_n_bye)",
		"exten => i,1,Playback(invalid)",
		"Dial(PJSIP/100,25,tT)",
		"Dial(PJSIP/100&PJSIP/101,30,tT)",
		"VoiceMail(100@default,u)",
		"Dial(PJSIP/+79990001122@provider,30,tT)",
		"Playback(goodbye)",
		"Hangup()",
	}
	for _, s := range expected {
		if !strings.Contains(ext, s) {
			t.Errorf("ожидалось в диалплане: %q\n---\n%s", s, ext)
		}
	}
	// после цифровых строк IVR цепочка возвращается к extension s якорем
	if !strings.Contains(ext, "exten => s,n(m_n_dial1),NoOp(>>> Вызов абонента)") {
		t.Errorf("цепочка ветвей IVR не привязана к extension s:\n%s", ext)
	}
	if strings.Contains(ext, "exten => i,1,Playback(invalid)\nsame => n(m_n_dial1)") {
		t.Errorf("same продолжает чужой extension — метка недостижима:\n%s", ext)
	}
	// неверный ввод IVR возвращает в меню
	if !strings.Contains(ext, "Goto(gui-demo1-in-1,s,m_n_iv)") {
		t.Error("неверный ввод IVR должен возвращать в меню")
	}
	// демо не должно давать предупреждений
	if len(r.warnings) != 0 {
		t.Errorf("неожиданные предупреждения: %v", r.warnings)
	}
}

func TestOutboundCompile(t *testing.T) {
	reg := demoRegistry()
	sc := demoSchemeOutbound()
	r := compileScheme(sc, reg)
	if !strings.Contains(r.extensions, "exten => _89XXXXXXXXX,1") {
		t.Error("нет шаблона исходящего маршрута")
	}
	if !strings.Contains(r.extensions, "Dial(PJSIP/${EXTEN}@provider,60,tT)") {
		t.Error("нет набора через транк")
	}
}

func TestNoEntryWarning(t *testing.T) {
	sc := &Scheme{ID: "x1", Name: "Пустая", Nodes: []Node{mkNode("n1", "hangup", 0, 0, map[string]any{})}, Edges: []Edge{}}
	r := compileScheme(sc, demoRegistry())
	found := false
	for _, w := range r.warnings {
		if strings.Contains(w, "точки входа") {
			found = true
		}
	}
	if !found {
		t.Error("нет предупреждения о точке входа")
	}
}

func TestTimeBranches(t *testing.T) {
	mk := func(edges []Edge) *Scheme {
		return &Scheme{ID: "t2", Name: "T2", Nodes: []Node{
			mkNode("i", "inbound", 0, 0, map[string]any{"did": "s"}),
			mkNode("tm", "time", 1, 1, map[string]any{"start": "09:00", "end": "18:00", "days": "mon-fri"}),
			mkNode("a", "answer", 2, 0, map[string]any{"delay": 0}),
			mkNode("b", "busy", 2, 2, map[string]any{"seconds": 5}),
		}, Edges: edges}
	}
	reg := demoRegistry()
	both := mk([]Edge{
		mkEdge("e1", "i", "out", "tm"),
		mkEdge("e2", "tm", "match", "a"),
		mkEdge("e3", "tm", "nomatch", "b"),
	})
	ext := compileScheme(both, reg).extensions
	if !strings.Contains(ext, "GotoIfTime(09:00-18:00,mon-fri,*,*?gui-t2-in-1,s,m_a)") {
		t.Errorf("неверная ветка «входит»:\n%s", ext)
	}
	if !strings.Contains(ext, "Goto(gui-t2-in-1,s,m_b)") {
		t.Errorf("неверная ветка «не входит»:\n%s", ext)
	}
	// только один выход подключён
	one := mk([]Edge{mkEdge("e1", "i", "out", "tm"), mkEdge("e2", "tm", "match", "a")})
	one.ID = "t3"
	ext = compileScheme(one, reg).extensions
	if !strings.Contains(ext, "GotoIfTime(09:00-18:00,mon-fri,*,*?gui-t3-in-1,s,m_a)") {
		t.Errorf("неверная ветка при одном выходе:\n%s", ext)
	}
}

func TestProjectCompile(t *testing.T) {
	reg := demoRegistry()
	p := compileProject([]*Scheme{demoScheme(), demoSchemeOutbound()}, reg)
	if !strings.Contains(p.Extensions, "[gui-internal]") {
		t.Error("нет внутреннего контекста")
	}
	if !strings.Contains(p.Extensions, "include => gui-demo2-out-1") {
		t.Error("нет include исходящего маршрута")
	}
	if !strings.Contains(p.Pjsip, "type=endpoint") {
		t.Error("pjsip без endpoint-ов")
	}
	if !strings.Contains(p.Pjsip, "[provider]") {
		t.Error("pjsip без транка provider")
	}
}
