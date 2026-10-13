// Демонстрационные данные первого запуска.
package main

func demoRegistry() *Registry {
	return &Registry{
		Devices: []Device{
			{Name: "Менеджер", Number: "100", Secret: randomHex(9), Context: "gui-internal"},
			{Name: "Ресепшн", Number: "101", Secret: randomHex(9), Context: "gui-internal"},
		},
		Trunks: []Trunk{
			{Name: "provider", Host: "sip.provider.example", Port: 5060, Inbound: true, Context: "gui-demo1-in-1"},
		},
	}
}

func mkNode(id, typ string, x, y float64, data map[string]any) Node {
	return Node{ID: id, Type: typ, X: x, Y: y, Data: data}
}

func mkEdge(id, from, port, to string) Edge {
	var e Edge
	e.ID = id
	e.From = PortRef{Node: from, Port: port}
	e.To.Node = to
	return e
}

func demoScheme() *Scheme {
	nodes := []Node{
		mkNode("n_in", "inbound", 40, 60, map[string]any{"did": "s", "trunk": "provider", "recordAll": false}),
		mkNode("n_ans", "answer", 280, 60, map[string]any{"delay": 0}),
		mkNode("n_greet", "playback", 520, 60, map[string]any{"greeting": "hello", "interruptible": false}),
		mkNode("n_iv", "ivr", 760, 60, map[string]any{
			"greeting": "demo-congrats", "timeout": 10,
			"keys": []any{"1", "2", "0"}, "useT": true, "useI": false,
		}),
		mkNode("n_dial1", "dial", 1060, -140, map[string]any{"device": "100", "timeout": 25, "options": "tT"}),
		mkNode("n_vm1", "voicemail", 1350, -140, map[string]any{"box": "100", "context": "default", "mode": "u", "exit": false}),
		mkNode("n_rg", "ringgroup", 1060, 60, map[string]any{"mode": "par", "timeout": 30, "members": []any{"100", "101"}}),
		mkNode("n_vm2", "voicemail", 1350, 60, map[string]any{"box": "101", "context": "default", "mode": "u", "exit": false}),
		mkNode("n_fwd", "forward", 1060, 260, map[string]any{"number": "+79990001122", "trunk": "provider", "timeout": 30}),
		mkNode("n_bye", "playback", 1060, 460, map[string]any{"greeting": "goodbye", "interruptible": false}),
		mkNode("n_hang", "hangup", 1350, 460, map[string]any{"cause": ""}),
	}
	edges := []Edge{
		mkEdge("e01", "n_in", "out", "n_ans"),
		mkEdge("e02", "n_ans", "out", "n_greet"),
		mkEdge("e03", "n_greet", "out", "n_iv"),
		mkEdge("e04", "n_iv", "k1", "n_dial1"),
		mkEdge("e05", "n_dial1", "out", "n_vm1"),
		mkEdge("e06", "n_iv", "k2", "n_rg"),
		mkEdge("e07", "n_rg", "out", "n_vm2"),
		mkEdge("e08", "n_iv", "k0", "n_fwd"),
		mkEdge("e09", "n_fwd", "out", "n_hang"),
		mkEdge("e10", "n_iv", "kt", "n_bye"),
		mkEdge("e11", "n_bye", "out", "n_hang"),
	}
	return &Scheme{
		ID: "demo1", Name: "Демо · Входящий вызов",
		Description: "Пример: приветствие → IVR-меню (1 — продажи, 2 — приёмная, 0 — мобильный).",
		Nodes: nodes, Edges: edges, UpdatedAt: nowISO(),
	}
}

func demoSchemeOutbound() *Scheme {
	nodes := []Node{
		mkNode("o_start", "outbound", 60, 80, map[string]any{"pattern": "_89XXXXXXXXX"}),
		mkNode("o_cid", "setcallerid", 330, 80, map[string]any{"number": "74951234567", "name": ""}),
		mkNode("o_rec", "record", 590, 80, map[string]any{"mode": "start", "name": "out", "append": false}),
		mkNode("o_trunk", "outtrunk", 850, 80, map[string]any{"trunk": "provider", "useDialed": true, "timeout": 60}),
		mkNode("o_busy", "busy", 1150, 80, map[string]any{"seconds": 5}),
	}
	edges := []Edge{
		mkEdge("e01", "o_start", "out", "o_cid"),
		mkEdge("e02", "o_cid", "out", "o_rec"),
		mkEdge("e03", "o_rec", "out", "o_trunk"),
		mkEdge("e04", "o_trunk", "out", "o_busy"),
	}
	return &Scheme{
		ID: "demo2", Name: "Демо · Исходящий маршрут",
		Description: "Мобильные (89…) → запись разговора → транк провайдера; по неответу — «занято».",
		Nodes: nodes, Edges: edges, UpdatedAt: nowISO(),
	}
}
