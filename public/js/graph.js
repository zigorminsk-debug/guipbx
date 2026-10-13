'use strict';
/**
 * Полигон монтажа: холст с панорамой/зумом, перетаскивание блоков,
 * соединение портов проводами (SVG-безье), выделение и удаление.
 */
(function () {
  const NODE_W = 192, HEADER_H = 28, ROW_H = 22, PAD_B = 6, SUM_LINE = 15;

  function nodeGeometry(node) {
    const def = window.BLOCK_DEFS[node.type] || { inputs: 1 };
    const ins = def.inputs || 0;
    const outs = window.outputsOf(node).length || (def.outputsFn ? 0 : (def.outputs || []).length);
    const rows = Math.max(ins, outs, 1);
    const sumLines = ((window.BLOCK_DEFS[node.type] || {}).summary || (() => []))(node.data || {}).filter(Boolean).length;
    const sumH = sumLines > 0 ? 4 + sumLines * SUM_LINE : 0;
    const h = HEADER_H + sumH + rows * ROW_H + PAD_B;
    return { ins, outs: window.outputsOf(node), w: NODE_W, h, sumH };
  }

  function portPos(node, kind, portId) {
    const g = nodeGeometry(node);
    const base = node.y + HEADER_H + g.sumH;
    if (kind === 'in') return { x: node.x, y: base + ROW_H / 2 };
    const i = g.outs.findIndex(o => o.id === portId);
    return { x: node.x + NODE_W, y: base + Math.max(i, 0) * ROW_H + ROW_H / 2 };
  }

  function bezier(a, b) {
    const dx = Math.max(45, Math.abs(b.x - a.x) * 0.45);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }

  class GraphEditor {
    /**
     * @param opts {canvas, layer, nodesEl, svgEl, onSelect, onChange, onWillMutate, onAddEdge}
     */
    constructor(opts) {
      this.canvas = opts.canvas;
      this.layer = opts.layer;
      this.nodesEl = opts.nodesEl;
      this.svgEl = opts.svgEl;
      this.onSelect = opts.onSelect || (() => {});
      this.onChange = opts.onChange || (() => {});
      this.onWillMutate = opts.onWillMutate || (() => {});
      this.graph = { nodes: [], edges: [] };
      this.view = { x: 30, y: 20, s: 1 };
      this.selected = null; // {kind:'node'|'edge', id}
      this.drag = null;     // drag-состояние
      this.connect = null;  // соединение-состояние
      this.idSeq = 1;
      this._bind();
      this.render();
    }

    setGraph(g) {
      this.graph = g && Array.isArray(g.nodes) ? g : { nodes: [], edges: [] };
      this.selected = null;
      this.render();
    }
    getGraph() { return this.graph; }

    /* ── координатные преобразования ── */
    toLayer(cx, cy) {
      const r = this.canvas.getBoundingClientRect();
      return { x: (cx - r.left - this.view.x) / this.view.s, y: (cy - r.top - this.view.y) / this.view.s };
    }
    applyView() {
      this.layer.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.s})`;
      const zl = document.getElementById('zoomLevel');
      if (zl) zl.textContent = Math.round(this.view.s * 100) + '%';
    }
    zoomAt(cx, cy, factor) {
      const s2 = Math.min(2.4, Math.max(0.3, this.view.s * factor));
      const r = this.canvas.getBoundingClientRect();
      const mx = cx - r.left, my = cy - r.top;
      this.view.x = mx - (mx - this.view.x) * (s2 / this.view.s);
      this.view.y = my - (my - this.view.y) * (s2 / this.view.s);
      this.view.s = s2;
      this.applyView();
    }
    zoomReset() { this.view = { x: 30, y: 20, s: 1 }; this.applyView(); }

    /* ── события мыши ── */
    _bind() {
      const cv = this.canvas;

      cv.addEventListener('contextmenu', e => e.preventDefault());

      cv.addEventListener('wheel', e => {
        e.preventDefault();
        this.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016));
      }, { passive: false });

      cv.addEventListener('pointerdown', e => {
        if (e.target === cv || e.target === this.layer || e.target === this.svgEl) {
          // панорама
          this.select(null);
          this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: this.view.x, vy: this.view.y };
          cv.classList.add('panning');
          cv.setPointerCapture(e.pointerId);
        }
      });

      window.addEventListener('pointermove', e => {
        if (this.drag) {
          const d = this.drag;
          if (d.kind === 'pan') {
            this.view.x = d.vx + (e.clientX - d.sx);
            this.view.y = d.vy + (e.clientY - d.sy);
            this.applyView();
          } else if (d.kind === 'node') {
            if (!d.moved) this.onWillMutate(); // снимок для undo перед первым сдвигом
            d.moved = true;
            const p = this.toLayer(e.clientX, e.clientY);
            d.node.x = Math.round((p.x - d.ox) / 5) * 5;
            d.node.y = Math.round((p.y - d.oy) / 5) * 5;
            const el = this.nodesEl.querySelector(`[data-node="${d.node.id}"]`);
            if (el) { el.style.left = d.node.x + 'px'; el.style.top = d.node.y + 'px'; }
            this.renderEdges();
          }
        } else if (this.connect) {
          this.connect.mouse = this.toLayer(e.clientX, e.clientY);
          this.renderEdges();
        }
      });

      window.addEventListener('pointerup', e => {
        if (this.drag) {
          if (this.drag.kind === 'node' && this.drag.moved) this.onChange();
          this.drag = null;
          this.canvas.classList.remove('panning');
        }
        if (this.connect) {
          const c = this.connect;
          this.connect = null;
          const hit = document.elementFromPoint(e.clientX, e.clientY);
          const portEl = hit && hit.closest ? hit.closest('.port-in, .port-in-anchor') : null;
          if (portEl) {
            const anchor = portEl.closest('.port-in') || portEl;
            const toNode = anchor.dataset.node || portEl.dataset.node;
            const fromNode = c.node.id;
            // запрещаем петлю блока на самого себя; слияние ветвей — можно
            const isIvrKey = /^k/.test(c.portId);
            if (fromNode !== toNode || isIvrKey) {
              this.addEdge(c.node.id, c.portId, toNode);
            } else this.renderEdges();
          } else this.renderEdges();
        }
      });
    }

    /* ── выбор/удаление ── */
    select(sel) {
      this.selected = sel;
      this.nodesEl.querySelectorAll('.node.selected').forEach(n => n.classList.remove('selected'));
      if (sel && sel.kind === 'node') {
        const el = this.nodesEl.querySelector(`[data-node="${sel.id}"]`);
        if (el) el.classList.add('selected');
      }
      this.renderEdges();
      this.onSelect(sel);
    }

    deleteSelected() {
      const sel = this.selected;
      if (!sel) return;
      this.onWillMutate();
      if (sel.kind === 'node') {
        this.graph.nodes = this.graph.nodes.filter(n => n.id !== sel.id);
        this.graph.edges = this.graph.edges.filter(e => e.from.node !== sel.id && e.to.node !== sel.id);
      } else if (sel.kind === 'edge') {
        this.graph.edges = this.graph.edges.filter(e => e.id !== sel.id);
      }
      this.selected = null;
      this.onSelect(null);
      this.render();
      this.onChange();
    }

    duplicateSelected() {
      const sel = this.selected;
      if (!sel || sel.kind !== 'node') return;
      const src = this.graph.nodes.find(n => n.id === sel.id);
      if (!src) return;
      this.onWillMutate();
      const copy = JSON.parse(JSON.stringify(src));
      copy.id = 'n' + Date.now().toString(36) + (this.idSeq++);
      copy.x += 40; copy.y += 40;
      this.graph.nodes.push(copy);
      this.render();
      this.select({ kind: 'node', id: copy.id });
      this.onChange();
    }

    addNode(type, lx, ly) {
      this.onWillMutate();
      const node = {
        id: 'n' + Date.now().toString(36) + (this.idSeq++),
        type, x: Math.round(lx / 5) * 5, y: Math.round(ly / 5) * 5,
        data: window.defaultData(type),
      };
      this.graph.nodes.push(node);
      this.render();
      this.select({ kind: 'node', id: node.id });
      this.onChange();
      return node;
    }

    addEdge(fromNode, fromPort, toNode) {
      // слияние веток разрешено: на один вход может идти несколько проводов;
      // точная копия (тот же порт → тот же вход) не создаётся
      const dup = this.graph.edges.some(e => e.from.node === fromNode && e.from.port === fromPort && e.to.node === toNode);
      if (dup) { this.renderEdges(); return; }
      this.onWillMutate();
      this.graph.edges.push({
        id: 'e' + Date.now().toString(36) + (this.idSeq++),
        from: { node: fromNode, port: fromPort },
        to: { node: toNode },
      });
      this.render();
      this.onChange();
    }

    removeEdgesFromPort(nodeId, portId) {
      const n = this.graph.edges.length;
      this.graph.edges = this.graph.edges.filter(e => !(e.from.node === nodeId && e.from.port === portId));
      if (this.graph.edges.length !== n) { this.render(); this.onChange(); }
    }

    /* ── рендеринг ── */
    render() {
      // узлы
      this.nodesEl.innerHTML = '';
      this.graph.nodes.forEach(node => {
        const def = window.BLOCK_DEFS[node.type] || { title: node.type, icon: '❓', color: '#888', inputs: 1 };
        const g = nodeGeometry(node);
        const el = document.createElement('div');
        el.className = 'node' + (def.cat === 'entry' ? ' node-entry' : '');
        el.dataset.node = node.id;
        el.style.cssText = `left:${node.x}px;top:${node.y}px;width:${g.w}px;height:${g.h}px;--nc:${def.color}`;
        if (this.selected && this.selected.kind === 'node' && this.selected.id === node.id) el.classList.add('selected');

        const sum = (def.summary || (() => []))(node.data || {}).filter(Boolean)
          .slice(0, 3).map(s => `<div class="node-sum">${escapeHtml(s)}</div>`).join('');

        const ins = def.inputs ? 1 : 0;
        const outs = g.outs;
        const rowCount = Math.max(ins, outs.length, 1);
        let rows = '';
        for (let i = 0; i < rowCount; i++) {
          const inH = i === 0 && ins
            ? `<span class="pr-in">вход</span><div class="port port-in" data-port="in" data-node="${node.id}"><div class="port-in-anchor" data-node="${node.id}"></div></div>` : '';
          const out = outs[i];
          const label = out ? `<span class="pr-out">${escapeHtml(out.label || out.id)}</span>` : '';
          const pdot = out ? `<div class="port port-out" data-port="${out.id}" data-node="${node.id}" title="Тяните, чтобы соединить"></div>` : '';
          rows += `<div class="port-row" style="position:relative">${inH}${label}${pdot}</div>`;
        }

        el.innerHTML = `
          <div class="node-head"><span class="nh-icon">${def.icon}</span><span>${escapeHtml(def.title)}</span></div>
          <div class="node-body">${sum}</div>
          <div class="node-ports">${rows}</div>`;

        // перетаскивание
        el.addEventListener('pointerdown', e => {
          if (e.button !== 0) return;
          if (e.target.closest('.port')) return;
          e.stopPropagation();
          const p = this.toLayer(e.clientX, e.clientY);
          this.drag = { kind: 'node', node, ox: p.x - node.x, oy: p.y - node.y, moved: false };
          el.classList.add('dragging');
          el.setPointerCapture(e.pointerId);
          this.select({ kind: 'node', id: node.id });
        });
        window.addEventListener('pointerup', () => el.classList.remove('dragging'), { once: true });

        el.addEventListener('dblclick', () => this.select({ kind: 'node', id: node.id }));

        // начало соединения
        el.querySelectorAll('.port-out').forEach(p => {
          p.addEventListener('pointerdown', e => {
            e.stopPropagation();
            e.preventDefault();
            const onto = this.graph.edges.find(ed => ed.from.node === node.id && ed.from.port === p.dataset.port);
            if (onto && e.altKey) { // Alt+клик — отсоединить
              this.removeEdgesFromPort(node.id, p.dataset.port);
              return;
            }
            this.connect = { node, portId: p.dataset.port, mouse: this.toLayer(e.clientX, e.clientY) };
            this.renderEdges();
          });
          p.addEventListener('dblclick', () => this.removeEdgesFromPort(node.id, p.dataset.port));
        });

        this.nodesEl.appendChild(el);
      });
      // «якорь» входного порта — увеличенная область для попадания курсором
      this.nodesEl.querySelectorAll('.port-in').forEach(p => {
        const a = p.querySelector('.port-in-anchor');
        a.style.cssText = 'position:absolute;left:-12px;top:-10px;width:26px;height:32px;pointer-events:none;';
        p.style.pointerEvents = 'auto';
      });
      this.renderEdges();
      this.applyView();
    }

    renderEdges() {
      const svg = this.svgEl;
      const byId = {};
      this.graph.nodes.forEach(n => (byId[n.id] = n));
      let html = '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="edge-arrow" d="M0,0L10,5L0,10z"/></marker></defs><g transform="translate(10000,10000)">';
      this.graph.edges.forEach(e => {
        const a = byId[e.from.node], b = byId[e.to.node];
        if (!a || !b) return;
        const pa = portPos(a, 'out', e.from.port);
        const pb = portPos(b, 'in');
        const sel = this.selected && this.selected.kind === 'edge' && this.selected.id === e.id ? ' selected' : '';
        html += `<g class="edge-g${sel}" data-edge="${e.id}">
          <path class="edge-hit" d="${bezier(pa, pb)}" data-edge="${e.id}"/>
          <path class="edge" d="${bezier(pa, pb)}" marker-end="url(#arrow)"/>
        </g>`;
      });
      if (this.connect) {
        const pa = portPos(this.connect.node, 'out', this.connect.portId);
        html += `<path class="edge-temp" fill="none" d="${bezier(pa, this.connect.mouse)}"/>`;
      }
      html += '</g>';
      svg.innerHTML = html;
      svg.querySelectorAll('.edge-hit').forEach(p => {
        p.addEventListener('pointerdown', e => {
          e.stopPropagation();
          this.select({ kind: 'edge', id: p.dataset.edge });
        });
      });
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.GraphEditor = GraphEditor;
  window.escapeHtml = escapeHtml;
})();
