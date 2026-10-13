package main

import (
	"strings"
	"testing"
)

func TestContextsToCLI(t *testing.T) {
	reg := demoRegistry()
	sc := demoScheme()
	sr := compileScheme(sc, reg)
	commands, contexts, err := contextsToCLI(sr.extensions)
	if err != nil {
		t.Fatalf("contextsToCLI: %v\n%s", err, sr.extensions)
	}
	if len(contexts) != 1 || contexts[0] != "gui-demo1-in-1" {
		t.Fatalf("неожиданные контексты: %v", contexts)
	}
	if len(commands) == 0 || commands[0] != "dialplan remove context gui-demo1-in-1" {
		t.Errorf("первая команда должна очищать контекст, а не %q", commands[0])
	}

	joined := strings.Join(commands, "\n")

	// именованные приоритеты должны превратиться в числовые:
	// s,1 NoOp(in) — 2 NoOp(trunk) — 3 Set — 4 NoOp(ans) — 5 Answer — 6 NoOp — 7 Playback
	// — 8 NoOp(ivr) — 9 Background — 10 WaitExten — 11 Hangup — 12 NoOp(dial1) — 13 Dial(100)
	// — 14 NoOp — 15 VoiceMail — 16 Hangup — 17 NoOp(rg) — 18 Dial(100&101) — ... — 24 NoOp(hang) — 25 Hangup
	// — 26 NoOp(bye) — 27 Playback(goodbye) — 28 Goto(...,24)
	expected := []string{
		"dialplan add extension s,1,NoOp(>>> Входящий вызов) into gui-demo1-in-1",
		"dialplan add extension s,5,Answer() into gui-demo1-in-1",
		"dialplan add extension s,9,Background(demo-congrats) into gui-demo1-in-1",
		"dialplan add extension s,13,Dial(PJSIP/100,25,tT) into gui-demo1-in-1",
		"dialplan add extension s,18,Dial(PJSIP/100&PJSIP/101,30,tT) into gui-demo1-in-1",
		"dialplan add extension s,28,Goto(gui-demo1-in-1,s,24) into gui-demo1-in-1",
		"dialplan add extension 1,1,Goto(gui-demo1-in-1,s,12) into gui-demo1-in-1",
		"dialplan add extension 2,1,Goto(gui-demo1-in-1,s,17) into gui-demo1-in-1",
		"dialplan add extension 0,1,Goto(gui-demo1-in-1,s,22) into gui-demo1-in-1",
		"dialplan add extension t,1,Goto(gui-demo1-in-1,s,26) into gui-demo1-in-1",
	}
	for _, e := range expected {
		if !strings.Contains(joined, e) {
			t.Errorf("ожидалась команда: %q\n---\n%s", e, joined)
		}
	}

	// никаких именованных приоритетов в командах
	for _, c := range commands {
		if strings.Contains(c, ",m_") {
			t.Errorf("метка не разрешена в команде: %q", c)
		}
	}
}

func TestContextsToCLIIncludes(t *testing.T) {
	reg := demoRegistry()
	p := compileProject([]*Scheme{demoSchemeOutbound()}, reg)
	commands, contexts, err := contextsToCLI(p.Extensions)
	if err != nil {
		t.Fatalf("contextsToCLI(project): %v", err)
	}
	joined := strings.Join(commands, "\n")
	// контексты проекта: outbound-контекст схемы + gui-internal
	foundInternal, foundScheme := false, false
	for _, c := range contexts {
		if c == "gui-internal" {
			foundInternal = true
		}
		if c == "gui-demo2-out-1" {
			foundScheme = true
		}
	}
	if !foundInternal || !foundScheme {
		t.Errorf("ожидались контексты gui-internal и gui-demo2-out-1, получили %v", contexts)
	}
	if !strings.Contains(joined, "dialplan add include gui-demo2-out-1 into gui-internal") {
		t.Errorf("нет include-команды:\n%s", joined)
	}
}
