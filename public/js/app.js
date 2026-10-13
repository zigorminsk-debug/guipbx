'use strict';
/**
 * GUIPBX — главная логика: палитра, схемы, свойства, компиляция, реестр, AMI.
 */
(function () {
  /* ═════════════ API ═════════════ */
  const api = {
    async req(method, url, body) {
      const r = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(data.error || ('HTTP ' + r.status)), { data });
      return data;
    },
    get: u => api.req('GET', u),
    post: (u, b) => api.req('POST', u, b),
    put: (u, b) => api.req('PUT', u, b),
    del: u => api.req('DELETE', u),
  };

  /* ═════════════ Тосты ═════════════ */
  function toast(msg, kind) {
    const box = document.getElementById('toasts');
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; setTimeout(() => t.remove(), 420); }, 4200);
  }

  /* ═════════════ Модалки ═════════════ */
  function openModal({ title, body, wide, foot }) {
    const root = document.getElementById('modalRoot');
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal${wide ? '' : ' small'}">
      <div class="modal-head"><h3>${escapeHtml(title)}</h3><button class="modal-close" title="Закрыть">✕</button></div>
      <div class="modal-body"></div>
      <div class="modal-foot" style="display:none"></div>
    </div>`;
    const close = () => ov.remove();
    ov.querySelector('.modal-close').onclick = close;
    ov.addEventListener('pointerdown', e => { if (e.target === ov) close(); });
    const bodyEl = ov.querySelector('.modal-body');
    const footEl = ov.querySelector('.modal-foot');
    if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
    if (foot && foot.length) {
      footEl.style.display = '';
      foot.forEach(b => footEl.appendChild(b));
    }
    root.appendChild(ov);
    return { ov, body: bodyEl, foot: footEl, close };
  }
  const mkBtn = (label, cls, fn) => {
    const b = document.createElement('button');
    b.className = 'tb-btn ' + (cls || '');
    b.innerHTML = label;
    b.onclick = fn;
    return b;
  };

  /* ═════════════ Состояние ═════════════ */
  const state = {
    schemes: [],
    scheme: null,       // текущая схема
    registry: { devices: [], trunks: [] },
    dirty: false,
    history: [], future: [],
    saving: false,
  };

  const editor = new GraphEditor({
    canvas: document.getElementById('canvas'),
    layer: document.getElementById('layer'),
    nodesEl: document.getElementById('nodes'),
    svgEl: document.getElementById('edges'),
    onSelect: showProps,
    onChange: onGraphChanged,
    onWillMutate: pushHistory,
  });

  function pushHistory() {
    if (!state.scheme) return;
    state.history.push(JSON.stringify({ nodes: state.scheme.nodes, edges: state.scheme.edges }));
    if (state.history.length > 60) state.history.shift();
    state.future.length = 0;
  }
  function restore(json) {
    const snap = JSON.parse(json);
    state.scheme.nodes = snap.nodes;
    state.scheme.edges = snap.edges;
    editor.setGraph({ nodes: state.scheme.nodes, edges: state.scheme.edges });
    markDirty();
  }
  function undo() {
    if (!state.history.length) return;
    state.future.push(JSON.stringify({ nodes: state.scheme.nodes, edges: state.scheme.edges }));
    restore(state.history.pop());
  }
  function redo() {
    if (!state.future.length) return;
    state.history.push(JSON.stringify({ nodes: state.scheme.nodes, edges: state.scheme.edges }));
    restore(state.future.pop());
  }

  function onGraphChanged() {
    if (!state.scheme) return;
    state.scheme.nodes = editor.graph.nodes;
    state.scheme.edges = editor.graph.edges;
    markDirty();
  }
  function markDirty() {
    state.dirty = true;
    setSaveStatus('Не сохранено…');
  }
  function setSaveStatus(txt, ok) {
    const el = document.getElementById('saveStatus');
    el.textContent = txt || '';
    el.className = 'save-status' + (ok ? ' saved' : '');
  }

  /* ═════════════ Палитра ═════════════ */
  function buildPalette() {
    const list = document.getElementById('paletteList');
    list.innerHTML = '';
    const query = (document.getElementById('paletteSearch').value || '').toLowerCase();
    window.BLOCK_CATEGORIES.forEach(cat => {
      const wrap = document.createElement('div');
      wrap.className = 'pal-cat';
      let visible = 0;
      const items = [];
      Object.entries(window.BLOCK_DEFS).forEach(([type, def]) => {
        if (def.cat !== cat.id) return;
        const hit = !query || def.title.toLowerCase().includes(query) || (def.desc || '').toLowerCase().includes(query);
        const it = document.createElement('div');
        it.className = 'pal-item' + (hit ? '' : ' hidden');
        it.style.setProperty('--pc', def.color);
        it.innerHTML = `<span class="pal-icon">${def.icon}</span>
          <span><div class="pal-name">${def.title}</div><div class="pal-desc">${def.desc || ''}</div></span>`;
        if (hit) visible++;
        it.addEventListener('pointerdown', e => startPaletteDrag(e, type));
        items.push(it);
      });
      if (!visible) return;
      const title = document.createElement('div');
      title.className = 'pal-cat-title';
      title.textContent = cat.title;
      wrap.appendChild(title);
      items.forEach(i => wrap.appendChild(i));
      list.appendChild(wrap);
    });
  }
  document.getElementById('paletteSearch').addEventListener('input', buildPalette);

  function startPaletteDrag(e, type) {
    e.preventDefault();
    const def = window.BLOCK_DEFS[type];
    const ghost = document.createElement('div');
    ghost.className = 'pal-item';
    ghost.style.cssText = `position:fixed;z-index:300;pointer-events:none;opacity:.85;--pc:${def.color};width:200px;left:${e.clientX - 100}px;top:${e.clientY - 18}px;`;
    ghost.innerHTML = `<span class="pal-icon">${def.icon}</span><span><div class="pal-name">${def.title}</div></span>`;
    document.body.appendChild(ghost);
    const move = ev => { ghost.style.left = ev.clientX - 100 + 'px'; ghost.style.top = ev.clientY - 18 + 'px'; };
    const up = ev => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      ghost.remove();
      const canvas = document.getElementById('canvas');
      const r = canvas.getBoundingClientRect();
      if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
        const p = editor.toLayer(ev.clientX, ev.clientY);
        editor.addNode(type, p.x - 96, p.y - 16);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /* ═════════════ Свойства ═════════════ */
  function showProps(sel) {
    const bodyEl = document.getElementById('propsBody');
    const headEl = document.getElementById('propsHeader');
    bodyEl.innerHTML = '';
    if (!sel || sel.kind !== 'node') {
      headEl.textContent = 'Свойства блока';
      bodyEl.innerHTML = '<div class="props-empty">Выберите блок на полигоне,<br>чтобы настроить его параметры</div>';
      return;
    }
    const node = state.scheme.nodes.find(n => n.id === sel.id);
    if (!node) return;
    const def = window.BLOCK_DEFS[node.type] || {};
    headEl.innerHTML = `${def.icon || ''} ${escapeHtml(def.title || node.type)}`;

    if (node.type === 'inbound' || node.type === 'outbound') {
      const note = document.createElement('div');
      note.className = 'props-scheme-note';
      note.innerHTML = node.type === 'inbound'
        ? 'Это точка входа. Маршрутизация на схему задаётся у транка: <code>context=gui-' + state.scheme.id + '-in-1</code>'
        : 'Исходящий маршрут. Контекст <code>gui-' + state.scheme.id + '-out-1</code> автоматически подключается к <code>gui-internal</code> при компиляции.';
      bodyEl.appendChild(note);
    }

    (def.fields || []).forEach(f => {
      const wrap = document.createElement('div');
      wrap.className = 'pf';
      const id = 'pf_' + f.key;
      if (f.type === 'checkbox') {
        wrap.innerHTML = `<div class="pf-check"><input type="checkbox" id="${id}" ${node.data[f.key] ? 'checked' : ''}><label for="${id}">${escapeHtml(f.label)}</label></div>`;
        wrap.querySelector('input').addEventListener('change', ev => setData(node, f.key, ev.target.checked));
      } else if (f.type === 'select' && !f.editable) {
        const opts = f.options.map(o => {
          const [v, t] = Array.isArray(o) ? o : [o, o];
          return `<option value="${escapeHtml(v)}" ${String(node.data[f.key]) === String(v) ? 'selected' : ''}>${escapeHtml(t)}</option>`;
        }).join('');
        wrap.innerHTML = `<label for="${id}">${escapeHtml(f.label)}</label><select id="${id}">${opts}</select>`;
        wrap.querySelector('select').addEventListener('change', ev => setData(node, f.key, ev.target.value));
      } else if (f.type === 'select' && f.editable) {
        const dl = 'dl_' + f.key;
        wrap.innerHTML = `<label for="${id}">${escapeHtml(f.label)}</label>
          <input id="${id}" list="${dl}" type="text" value="${escapeHtml(node.data[f.key] || '')}">
          <datalist id="${dl}">${f.options.map(o => `<option value="${escapeHtml(Array.isArray(o) ? o[0] : o)}">`).join('')}</datalist>`;
        wrap.querySelector('input').addEventListener('change', ev => setData(node, f.key, ev.target.value));
      } else if (f.type === 'textarea') {
        wrap.innerHTML = `<label for="${id}">${escapeHtml(f.label)}</label><textarea id="${id}">${escapeHtml(node.data[f.key] || '')}</textarea>`;
        wrap.querySelector('textarea').addEventListener('change', ev => setData(node, f.key, ev.target.value));
      } else if (f.type === 'number') {
        wrap.innerHTML = `<label for="${id}">${escapeHtml(f.label)}</label><input id="${id}" type="number" value="${Number(node.data[f.key]) || 0}">`;
        wrap.querySelector('input').addEventListener('change', ev => setData(node, f.key, Number(ev.target.value)));
      } else if (f.type === 'keys') {
        const cur = Array.isArray(node.data[f.key]) ? node.data[f.key] : [];
        wrap.innerHTML = `<label for="${id}">${escapeHtml(f.label)}</label><textarea id="${id}" rows="3">${escapeHtml(cur.join('\n'))}</textarea>`;
        wrap.querySelector('textarea').addEventListener('change', ev => {
          const keys = ev.target.value.split(/[\s,]+/).map(s => s.trim()).filter(s => /^[0-9*#]{1,2}$/.test(s));
          setData(node, f.key, [...new Set(keys)].slice(0, 13));
          ev.target.value = (node.data[f.key] || []).join('\n');
        });
      } else if (f.type === 'members') {
        const cur = new Set(Array.isArray(node.data[f.key]) ? node.data[f.key] : []);
        const box = document.createElement('div');
        box.className = 'pf-members';
        if (!state.registry.devices.length) box.innerHTML = '<div class="pf-help">Сначала добавьте абонентов в «Устройства и транки»</div>';
        state.registry.devices.forEach(d => {
          const lab = document.createElement('label');
          lab.innerHTML = `<input type="checkbox" ${cur.has(d.number) ? 'checked' : ''}> <b>${escapeHtml(d.number)}</b> · ${escapeHtml(d.name)}`;
          lab.querySelector('input').addEventListener('change', ev => {
            const arr = new Set(Array.isArray(node.data[f.key]) ? node.data[f.key] : []);
            ev.target.checked ? arr.add(d.number) : arr.delete(d.number);
            setData(node, f.key, [...arr]);
          });
          box.appendChild(lab);
        });
        wrap.innerHTML = `<label>${escapeHtml(f.label)}</label>`;
        wrap.appendChild(box);
      } else if (f.type === 'devref' || f.type === 'trunkref') {
        const src = f.type === 'devref' ? state.registry.devices : state.registry.trunks;
        const items = f.type === 'devref'
          ? src.map(d => ({ v: d.number, t: d.number + ' · ' + d.name }))
          : src.map(t => ({ v: t.name, t: t.name + ' (' + t.host + ')' }));
        const opts = ['<option value="">— не выбрано —</option>']
          .concat(items.map(i => `<option value="${escapeHtml(i.v)}" ${String(node.data[f.key]) === String(i.v) ? 'selected' : ''}>${escapeHtml(i.t)}</option>`)).join('');
        wrap.innerHTML = `<label for="${id}">${escapeHtml(f.label)}</label><select id="${id}">${opts}</select>`;
        wrap.querySelector('select').addEventListener('change', ev => setData(node, f.key, ev.target.value));
      } else {
        wrap.innerHTML = `<label for="${id}">${escapeHtml(f.label)}</label><input id="${id}" type="text" value="${escapeHtml(node.data[f.key] || '')}">`;
        wrap.querySelector('input').addEventListener('change', ev => setData(node, f.key, ev.target.value));
      }
      if (f.help) {
        const h = document.createElement('div');
        h.className = 'pf-help';
        h.textContent = f.help;
        wrap.appendChild(h);
      }
      bodyEl.appendChild(wrap);
    });

    const actions = document.createElement('div');
    actions.className = 'prop-actions';
    const dup = mkBtn('⧉ Дублировать', '', () => editor.duplicateSelected());
    const del = mkBtn('🗑 Удалить блок', 'danger', () => editor.deleteSelected());
    actions.appendChild(dup);
    actions.appendChild(del);
    bodyEl.appendChild(actions);
  }

  function setData(node, key, value) {
    pushHistory();
    const before = JSON.stringify(window.outputsOf(node).map(o => o.id));
    node.data[key] = value;
    const after = JSON.stringify(window.outputsOf(node).map(o => o.id));
    // если поменялся набор выходных портов — чистим висячие провода
    if (before !== after) {
      const valid = new Set(JSON.parse(after));
      editor.graph.edges = editor.graph.edges.filter(e => e.from.node !== node.id || valid.has(e.from.port));
      state.scheme.edges = editor.graph.edges;
    }
    editor.render();
    editor.select({ kind: 'node', id: node.id });
    markDirty();
  }

  /* ═════════════ Схемы ═════════════ */
  async function loadSchemes(keepId) {
    state.schemes = await api.get('/api/schemes');
    const sel = document.getElementById('schemeSelect');
    sel.innerHTML = state.schemes.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    if (!state.schemes.length) {
      const s = await api.post('/api/schemes', { name: 'Моя первая схема' });
      return loadSchemes(s.id);
    }
    const id = keepId && state.schemes.some(s => s.id === keepId) ? keepId : state.schemes[0].id;
    sel.value = id;
    await loadScheme(id);
  }

  async function loadScheme(id) {
    state.scheme = await api.get('/api/schemes/' + id);
    document.getElementById('schemeName').value = state.scheme.name;
    document.getElementById('schemeSelect').value = id;
    state.history.length = 0; state.future.length = 0;
    state.dirty = false;
    setSaveStatus('Загружено', true);
    editor.setGraph({ nodes: state.scheme.nodes, edges: state.scheme.edges });
    showProps(null);
  }

  async function saveScheme() {
    if (!state.scheme || state.saving) return;
    state.saving = true;
    try {
      state.scheme.name = document.getElementById('schemeName').value.trim() || state.scheme.name;
      state.scheme.nodes = editor.graph.nodes;
      state.scheme.edges = editor.graph.edges;
      await api.put('/api/schemes/' + state.scheme.id, state.scheme);
      state.dirty = false;
      setSaveStatus('Сохранено ' + new Date().toLocaleTimeString(), true);
      state.schemes = await api.get('/api/schemes');
      const sel = document.getElementById('schemeSelect');
      sel.innerHTML = state.schemes.map(s => `<option value="${s.id}" ${s.id === state.scheme.id ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
    } catch (e) {
      toast('Ошибка сохранения: ' + e.message, 'err');
    } finally {
      state.saving = false;
    }
  }

  document.getElementById('schemeSelect').addEventListener('change', async e => {
    if (state.dirty) await saveScheme();
    loadScheme(e.target.value);
  });
  document.getElementById('btnNewScheme').addEventListener('click', async () => {
    if (state.dirty) await saveScheme();
    const s = await api.post('/api/schemes', { name: 'Новая схема ' + (state.schemes.length + 1) });
    await loadSchemes(s.id);
    toast('Схема создана');
  });
  document.getElementById('btnDelScheme').addEventListener('click', async () => {
    if (!state.scheme) return;
    if (!confirm(`Удалить схему «${state.scheme.name}»?`)) return;
    await api.del('/api/schemes/' + state.scheme.id);
    state.dirty = false;
    await loadSchemes();
    toast('Схема удалена');
  });
  document.getElementById('schemeName').addEventListener('change', () => {
    if (state.scheme) { state.scheme.name = document.getElementById('schemeName').value.trim() || state.scheme.name; markDirty(); }
  });
  document.getElementById('btnSave').addEventListener('click', saveScheme);

  /* ═════════════ Компиляция ═════════════ */
  document.getElementById('btnCompile').addEventListener('click', async () => {
    await saveScheme();
    let data;
    try {
      data = await api.get('/api/schemes/' + state.scheme.id + '/compile');
    } catch (e) { toast('Ошибка компиляции: ' + e.message, 'err'); return; }
    const panes = [
      { id: 'ext', title: 'extensions.conf', text: data.extensions },
      { id: 'pjsip', title: 'pjsip.conf', text: data.pjsip },
    ];
    if (data.queues) panes.push({ id: 'queues', title: 'queues.conf', text: data.queues });
    panes.push({ id: 'warn', title: 'Проверки (' + data.warnings.length + ')', text: null });

    const body = document.createElement('div');
    body.innerHTML = `
      <div class="tabs">${panes.map((p, i) => `<button class="tab${i === 0 ? ' active' : ''}" data-p="${p.id}">${p.title}</button>`).join('')}</div>
      ${panes.map((p, i) => `<div class="tabpane" data-pane="${p.id}" style="${i ? 'display:none' : ''}">
        ${p.text != null
          ? `<pre>${escapeHtml(p.text)}</pre>`
          : data.warnings.length
            ? `<ul class="warn-list">${data.warnings.map(w => `<li>⚠ ${escapeHtml(w)}</li>`).join('')}</ul>`
            : '<div class="ok-note">✔ Проблем не найдено. Карта готова к работе.</div>'}
      </div>`).join('')}`;
    body.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
      body.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
      body.querySelectorAll('.tabpane').forEach(p => p.style.display = p.dataset.pane === t.dataset.p ? '' : 'none');
    }));

    const copy = mkBtn('📋 Копировать extensions.conf', '', async () => {
      await navigator.clipboard.writeText(data.extensions);
      toast('Скопировано в буфер');
    });
    const deploy = mkBtn('🚀 В работу', 'primary', () => { m.close(); openDeploy(); });
    const m = openModal({
      title: 'Диалплан по карте «' + state.scheme.name + '»',
      wide: true,
      body,
      foot: [copy, deploy, mkBtn('Закрыть', '', () => m.close())],
    });
    if (data.warnings.length) toast('Компиляция: замечаний — ' + data.warnings.length, '');
    else toast('Схема компилируется без замечаний ✔', 'ok');
  });

  document.getElementById('btnDownload').addEventListener('click', () => {
    saveScheme().then(() => {
      const a = document.createElement('a');
      a.href = '/api/project/download';
      a.download = 'extensions_gui.conf';
      a.click();
      toast('Скачан extensions_gui.conf — положите его в /etc/asterisk/ и подключите include-ом', 'ok');
    });
  });

  /* ═════════════ Деплой ═════════════ */
  function openDeploy() {
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="pf"><label>Путь для записи на Asterisk-хосте</label>
        <input type="text" id="deployPath" value="/etc/asterisk/extensions_gui.conf"></div>
      <div class="pf-help" style="margin-bottom:12px">
        GUIPBX запишет сгенерированный диалплан по пути выше (работает, если GUIPBX запущен на том же хосте, что и Asterisk).
        Затем добавьте в <b>/etc/asterisk/extensions.conf</b> строку <code style="color:#9fd4ff">#include "extensions_gui.conf"</code>
        и нажмите «В работу + перезагрузка диалплана» либо выполните <code style="color:#9fd4ff">asterisk -rx "dialplan reload"</code>.
      </div>
      <div id="deployResult"></div>`;
    const run = async (withReload) => {
      const res = body.querySelector('#deployResult');
      res.innerHTML = '';
      try {
        const r = await api.post('/api/deploy', { targetPath: body.querySelector('#deployPath').value });
        let html = `<div class="ok-note">✔ Записано ${r.bytes} байт в ${escapeHtml(r.path)}</div>`;
        if (withReload) {
          try {
            const rr = await amiReload();
            html += `<div class="ok-note" style="margin-top:8px">✔ Asterisk (${escapeHtml(rr.banner || 'OK')}): dialplan перезагружен — <b>карта в работе</b></div>`;
          } catch (e2) {
            html += `<ul class="warn-list" style="margin-top:8px"><li>⚠ Файл записан, но перезагрузка не удалась: ${escapeHtml(e2.message)}. Настройте AMI в «🔌 Asterisk» или перезагрузите вручную.</li></ul>`;
          }
        }
        if (r.warnings && r.warnings.length) html += '<ul class="warn-list" style="margin-top:8px">' + r.warnings.slice(0, 20).map(w => `<li>⚠ ${escapeHtml(w)}</li>`).join('') + '</ul>';
        res.innerHTML = html;
        toast('Диалплан выведен в работу', 'ok');
      } catch (e) {
        res.innerHTML = `<ul class="warn-list"><li>⚠ ${escapeHtml(e.message)}</li></ul>`;
      }
    };
    const m = openModal({
      title: 'Вывод карты в работу', wide: false, body,
      foot: [
        mkBtn('📄 Только записать файл', '', () => run(false)),
        mkBtn('🚀 Записать + dialplan reload', 'primary', () => run(true)),
        mkBtn('Закрыть', '', () => m.close()),
      ],
    });
  }
  document.getElementById('btnDeploy').addEventListener('click', () => { saveScheme().then(openDeploy); });

  /* ═════════════ Реестр устройств и транков ═════════════ */
  function genSecret() { return Array.from(crypto.getRandomValues(new Uint8Array(9))).map(b => b.toString(16).padStart(2, '0')).join(''); }

  function openRegistry() {
    const reg = JSON.parse(JSON.stringify(state.registry));
    const body = document.createElement('div');

    function render() {
      body.innerHTML = `
        <div class="reg-section-title">📱 SIP-абоненты (внутренние устройства)</div>
        <table class="reg-table"><thead><tr><th>Имя</th><th>Номер</th><th>Пароль</th><th></th><th></th></tr></thead>
        <tbody>${reg.devices.map((d, i) => `<tr>
          <td><input data-k="name" data-i="${i}" value="${escapeHtml(d.name)}"></td>
          <td style="width:88px"><input data-k="number" data-i="${i}" value="${escapeHtml(d.number)}"></td>
          <td><input data-k="secret" data-i="${i}" value="${escapeHtml(d.secret)}"></td>
          <td style="width:70px"><button class="mini-btn" data-newsecret="${i}">🔑 новый</button></td>
          <td style="width:30px"><button class="row-del" data-deldev="${i}">✕</button></td>
        </tr>`).join('')}</tbody></table>
        <button class="reg-add" id="addDev">＋ Добавить абонента</button>

        <div class="reg-section-title">🌐 SIP-транки (операторы)</div>
        <table class="reg-table"><thead><tr><th>Имя</th><th>Хост</th><th>Порт</th><th>Логин</th><th>Пароль</th><th>Рег.</th><th>Вх.</th><th></th></tr></thead>
        <tbody>${reg.trunks.map((t, i) => `<tr>
          <td><input data-tk="name" data-i="${i}" value="${escapeHtml(t.name)}"></td>
          <td><input data-tk="host" data-i="${i}" value="${escapeHtml(t.host)}"></td>
          <td style="width:70px"><input data-tk="port" data-i="${i}" value="${t.port || 5060}"></td>
          <td><input data-tk="username" data-i="${i}" value="${escapeHtml(t.username || '')}"></td>
          <td><input data-tk="password" data-i="${i}" value="${escapeHtml(t.password || '')}"></td>
          <td style="width:34px;text-align:center"><input type="checkbox" data-tk="register" data-i="${i}" ${t.register ? 'checked' : ''} style="width:15px;height:15px"></td>
          <td style="width:34px;text-align:center"><input type="checkbox" data-tk="inbound" data-i="${i}" ${t.inbound ? 'checked' : ''} style="width:15px;height:15px"></td>
          <td style="width:30px"><button class="row-del" data-deltr="${i}">✕</button></td>
        </tr>`).join('')}</tbody></table>
        <button class="reg-add" id="addTr">＋ Добавить транк</button>
        <div class="pf-help" style="margin-top:10px">«Рег.» — исходящая регистрация у провайдера; «Вх.» — принимать входящие с этого транка (identify по хосту).</div>`;

      body.querySelectorAll('input[data-k]').forEach(inp => inp.addEventListener('change', () => {
        reg.devices[Number(inp.dataset.i)][inp.dataset.k] = inp.value.trim();
      }));
      body.querySelectorAll('input[data-tk]').forEach(inp => inp.addEventListener('change', () => {
        const k = inp.dataset.tk;
        reg.trunks[Number(inp.dataset.i)][k] = inp.type === 'checkbox' ? inp.checked : (k === 'port' ? Number(inp.value) : inp.value.trim());
      }));
      body.querySelectorAll('[data-newsecret]').forEach(b => b.onclick = () => { reg.devices[Number(b.dataset.newsecret)].secret = genSecret(); render(); });
      body.querySelectorAll('[data-deldev]').forEach(b => b.onclick = () => { reg.devices.splice(Number(b.dataset.deldev), 1); render(); });
      body.querySelectorAll('[data-deltr]').forEach(b => b.onclick = () => { reg.trunks.splice(Number(b.dataset.deltr), 1); render(); });
      body.querySelector('#addDev').onclick = () => {
        const next = Math.max(99, ...reg.devices.map(d => Number(d.number) || 0)) + 1;
        reg.devices.push({ name: 'Абонент ' + next, number: String(next), secret: genSecret(), context: 'gui-internal' });
        render();
      };
      body.querySelector('#addTr').onclick = () => {
        reg.trunks.push({ name: 'trunk' + (reg.trunks.length + 1), host: 'sip.example.com', port: 5060, username: '', password: '', register: false, inbound: true, context: '' });
        render();
      };
    }
    render();

    const save = mkBtn('💾 Сохранить реестр', 'primary', async () => {
      try {
        const r = await api.put('/api/registry', reg);
        state.registry = reg;
        toast(`Сохранено: ${r.devices} устройств, ${r.trunks} транков. pjsip.conf будет перегенерирован при компиляции.`, 'ok');
        m.close();
      } catch (e) { toast('Ошибка: ' + e.message, 'err'); }
    });
    const m = openModal({ title: 'Устройства и транки', wide: true, body, foot: [save, mkBtn('Отмена', '', () => m.close())] });
  }
  document.getElementById('btnRegistry').addEventListener('click', openRegistry);

  /* ═════════════ AMI ═════════════ */
  const AMI_KEY = 'guipbx.ami';
  const amiCfg = () => { try { return JSON.parse(localStorage.getItem(AMI_KEY)) || {}; } catch (_) { return {}; } };
  const setAmiCfg = c => localStorage.setItem(AMI_KEY, JSON.stringify(c));

  async function amiReload() {
    const c = amiCfg();
    const r = await api.post('/api/ami/reload', c);
    return r;
  }

  function openAmi() {
    const c = Object.assign({ host: location.hostname, port: 5038, user: 'admin', secret: '' }, amiCfg());
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="pf"><label>Хост Asterisk</label><input id="amiHost" type="text" value="${escapeHtml(c.host)}"></div>
      <div class="pf"><label>Порт AMI</label><input id="amiPort" type="number" value="${c.port}"></div>
      <div class="pf"><label>Пользователь AMI</label><input id="amiUser" type="text" value="${escapeHtml(c.user)}"></div>
      <div class="pf"><label>Секрет</label><input id="amiSecret" type="text" value="${escapeHtml(c.secret)}"></div>
      <div class="pf-help">Задаётся в /etc/asterisk/manager.conf: [admin] secret=… read=command write=command. Секрет хранится только в вашем браузере.</div>
      <div id="amiResult" style="margin-top:10px"></div>`;
    const collect = () => ({
      host: body.querySelector('#amiHost').value.trim(),
      port: Number(body.querySelector('#amiPort').value) || 5038,
      user: body.querySelector('#amiUser').value.trim(),
      secret: body.querySelector('#amiSecret').value,
    });
    const res = body.querySelector('#amiResult');
    const test = mkBtn('🔌 Проверить связь', '', async () => {
      setAmiCfg(collect()); res.innerHTML = '';
      try {
        const r = await api.post('/api/ami/test', amiCfg());
        res.innerHTML = `<div class="ok-note">✔ Asterisk Call Manager ${escapeHtml(r.banner || '')} — связь есть</div>`;
        setAstStatus(true);
      } catch (e) {
        res.innerHTML = `<ul class="warn-list"><li>⚠ ${escapeHtml(e.message)}</li></ul>`;
        setAstStatus(false);
      }
    });
    const reload = mkBtn('♻ dialplan reload', 'primary', async () => {
      setAmiCfg(collect());
      try { const r = await amiReload(); res.innerHTML = `<div class="ok-note">✔ Диалплан перезагружен (${escapeHtml(r.banner || 'OK')})</div>`; }
      catch (e) { res.innerHTML = `<ul class="warn-list"><li>⚠ ${escapeHtml(e.message)}</li></ul>`; }
    });
    const m = openModal({ title: 'Подключение к Asterisk (AMI)', wide: false, body, foot: [test, reload, mkBtn('Закрыть', '', () => m.close())] });
  }
  document.getElementById('btnAmi').addEventListener('click', openAmi);

  function setAstStatus(on) {
    const el = document.getElementById('asteriskStatus');
    el.classList.toggle('online', !!on);
    el.title = on ? 'Asterisk на связи' : 'Asterisk недоступен';
  }

  /* ═════════════ Зум и клавиатура ═════════════ */
  document.getElementById('zoomIn').onclick = () => editor.zoomAt(innerWidth / 2, innerHeight / 2, 1.2);
  document.getElementById('zoomOut').onclick = () => editor.zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.2);
  document.getElementById('zoomHome').onclick = () => editor.zoomReset();

  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName || '');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveScheme(); return; }
    if (typing) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); editor.deleteSelected(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); editor.duplicateSelected(); }
  });

  window.addEventListener('beforeunload', e => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  /* ═════════════ Старт ═════════════ */
  (async function boot() {
    buildPalette();
    try { state.registry = await api.get('/api/registry'); } catch (_) { /* пусто */ }
    await loadSchemes();
    // автосохранение каждые 20 сек при наличии изменений
    setInterval(() => { if (state.dirty && !document.querySelector('.modal-overlay')) saveScheme(); }, 20000);
  })();
})();
