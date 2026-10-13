'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const { compileScheme, compileProject } = require('./dialplan');
const ami = require('./ami');
const seeds = require('./seeds');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.GUIPBX_DATA || path.join(ROOT, 'data');
const SCHEMES_DIR = path.join(DATA_DIR, 'schemes');
const REGISTRY_PATH = path.join(DATA_DIR, 'registry.json');
const DEPLOY_PATH = process.env.GUIPBX_DEPLOY_PATH || '/etc/asterisk/extensions_gui.conf';

fs.mkdirSync(SCHEMES_DIR, { recursive: true });

// --- первый запуск: демо-данные -------------------------------------------
if (!fs.existsSync(REGISTRY_PATH)) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(seeds.demoRegistry(), null, 2));
}
if (fs.readdirSync(SCHEMES_DIR).filter(f => f.endsWith('.json')).length === 0) {
  fs.writeFileSync(path.join(SCHEMES_DIR, 'demo1.json'), JSON.stringify(seeds.demoScheme(), null, 2));
  fs.writeFileSync(path.join(SCHEMES_DIR, 'demo2.json'), JSON.stringify(seeds.demoSchemeOutbound(), null, 2));
}

// --- утилиты хранения -------------------------------------------------------
const validId = id => /^[a-zA-Z0-9_-]{1,40}$/.test(id || '');
const schemePath = id => path.join(SCHEMES_DIR, id + '.json');

function listSchemes() {
  return fs.readdirSync(SCHEMES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SCHEMES_DIR, f), 'utf8'));
        return { id: s.id, name: s.name, description: s.description || '', nodes: (s.nodes || []).length, edges: (s.edges || []).length, updatedAt: s.updatedAt || null };
      } catch (e) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}
const readScheme = id => JSON.parse(fs.readFileSync(schemePath(id), 'utf8'));
const readRegistry = () => JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const writeRegistry = r => fs.writeFileSync(REGISTRY_PATH, JSON.stringify(r, null, 2));
const readAllSchemes = () => listSchemes().map(m => readScheme(m.id));

// --- приложение --------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '6mb' }));
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(express.static(PUBLIC_DIR));

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'GUIPBX', time: new Date().toISOString() }));

// схемы
app.get('/api/schemes', (req, res) => res.json(listSchemes()));

app.post('/api/schemes', (req, res) => {
  const name = String((req.body && req.body.name) || 'Новая схема').slice(0, 120);
  const id = 's' + Date.now().toString(36);
  const scheme = { id, name, description: '', nodes: [], edges: [], updatedAt: new Date().toISOString() };
  fs.writeFileSync(schemePath(id), JSON.stringify(scheme, null, 2));
  res.json(scheme);
});

app.get('/api/schemes/:id', (req, res) => {
  const { id } = req.params;
  if (!validId(id) || !fs.existsSync(schemePath(id))) return res.status(404).json({ error: 'Схема не найдена' });
  res.json(readScheme(id));
});

app.put('/api/schemes/:id', (req, res) => {
  const { id } = req.params;
  if (!validId(id) || !fs.existsSync(schemePath(id))) return res.status(404).json({ error: 'Схема не найдена' });
  const b = req.body || {};
  const scheme = {
    id,
    name: String(b.name || 'Схема').slice(0, 120),
    description: String(b.description || '').slice(0, 500),
    nodes: Array.isArray(b.nodes) ? b.nodes : [],
    edges: Array.isArray(b.edges) ? b.edges : [],
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(schemePath(id) + '.tmp', JSON.stringify(scheme, null, 2));
  fs.renameSync(schemePath(id) + '.tmp', schemePath(id));
  res.json({ ok: true, updatedAt: scheme.updatedAt });
});

app.delete('/api/schemes/:id', (req, res) => {
  const { id } = req.params;
  if (!validId(id) || !fs.existsSync(schemePath(id))) return res.status(404).json({ error: 'Схема не найдена' });
  fs.unlinkSync(schemePath(id));
  res.json({ ok: true });
});

// компиляция
app.get('/api/schemes/:id/compile', (req, res) => {
  const { id } = req.params;
  if (!validId(id) || !fs.existsSync(schemePath(id))) return res.status(404).json({ error: 'Схема не найдена' });
  const registry = readRegistry();
  const r = compileScheme(readScheme(id), registry);
  const project = compileProject([readScheme(id)], registry);
  res.json({ extensions: r.extensions, pjsip: project.pjsip, queues: project.queues, warnings: r.warnings });
});

// весь проект одним файлом
app.get('/api/project/compile', (req, res) => {
  res.json(compileProject(readAllSchemes(), readRegistry()));
});

app.get('/api/project/download', (req, res) => {
  const c = compileProject(readAllSchemes(), readRegistry());
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="extensions_gui.conf"');
  res.send(c.extensions);
});

// реестр устройств/транков
app.get('/api/registry', (req, res) => res.json(readRegistry()));
app.put('/api/registry', (req, res) => {
  const b = req.body || {};
  const registry = {
    devices: (Array.isArray(b.devices) ? b.devices : []).map(d => ({
      name: String(d.name || '').slice(0, 80),
      number: String(d.number || '').replace(/[^0-9*#]/g, '').slice(0, 12),
      secret: String(d.secret || '').slice(0, 64),
      context: String(d.context || 'gui-internal').slice(0, 40),
    })).filter(d => d.number),
    trunks: (Array.isArray(b.trunks) ? b.trunks : []).map(t => ({
      name: String(t.name || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40),
      host: String(t.host || '').slice(0, 120),
      port: Number(t.port) || 5060,
      username: String(t.username || '').slice(0, 80),
      password: String(t.password || '').slice(0, 120),
      register: !!t.register,
      inbound: !!t.inbound,
      context: String(t.context || '').slice(0, 40),
    })).filter(t => t.name && t.host),
  };
  writeRegistry(registry);
  res.json({ ok: true, devices: registry.devices.length, trunks: registry.trunks.length });
});

// деплой: записать сгенерированный диалплан на диск Asterisk
app.post('/api/deploy', (req, res) => {
  const target = String((req.body && req.body.targetPath) || DEPLOY_PATH);
  const c = compileProject(readAllSchemes(), readRegistry());
  try {
    fs.writeFileSync(target, c.extensions);
    res.json({ ok: true, path: target, bytes: Buffer.byteLength(c.extensions), warnings: c.warnings });
  } catch (e) {
    res.status(500).json({ ok: false, error: `Не удалось записать ${target}: ${e.message}`, hint: 'Скачайте файл и скопируйте вручную, либо запустите GUIPBX на хосте Asterisk.' });
  }
});

// AMI
app.post('/api/ami/test', async (req, res) => {
  try {
    const r = await ami.testConnection(req.body || {});
    res.json({ ok: true, banner: r.banner });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});
app.post('/api/ami/reload', async (req, res) => {
  try {
    const r = await ami.reloadDialplan(req.body || {});
    res.json({ ok: true, banner: r.banner, responses: r.responses });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// станция (AMI): полноценная реализация — в Go-бинарнике; в dev-режиме — заглушки
app.all('/api/station/:action', (req, res) => {
  if (req.params.action === 'status') return res.json({ connected: false, dev: true });
  res.status(501).json({ error: 'Подключение к станции доступно в Go-сборке GUIPBX (dev-режим Node)', dev: true });
});
app.post('/api/ami/reload', async (req, res) => {
  try {
    const r = await ami.reloadDialplan(req.body || {});
    res.json({ ok: true, banner: r.banner, responses: r.responses });
  } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`GUIPBX запущен: http://0.0.0.0:${PORT}`);
  console.log(`Данные: ${DATA_DIR}`);
});
