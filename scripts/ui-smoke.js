'use strict';
/**
 * UI smoke-тест: поднимаем DOM (jsdom), выполняем клиентские скрипты
 * против живого сервера и проверяем, что редактор отрисовался.
 * Запуск: node scripts/ui-smoke.js [baseUrl]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const BASE = process.argv[2] || 'http://localhost:3000';

async function main() {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')
    .replace(/<script[^>]*><\/script>/g, ''); // скрипты исполним сами в нужном порядке

  const dom = new JSDOM(html, { url: BASE, pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;

  // стабы окружения
  window.fetch = (u, opts) => fetch(u.startsWith('http') ? u : BASE + u, opts)
    .then(r => ({ ok: r.ok, status: r.status, json: () => r.json() }));
  try { if (!window.crypto || !window.crypto.getRandomValues) Object.defineProperty(window, 'crypto', { value: require('crypto').webcrypto }); } catch (_) { /* jsdom уже даёт crypto */ }
  window.confirm = () => true;
  window.alert = () => {};
  window.Element.prototype.setPointerCapture = () => {};
  window.Element.prototype.releasePointerCapture = () => {};
  window.SVGElement = window.SVGElement || function () {};
  window.Element.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800, x: 0, y: 0 };
  };
  window.navigator.clipboard = { writeText: async () => {} };

  const ctx = vm.createContext(window);
  for (const f of ['blocks.js', 'graph.js', 'app.js']) {
    const code = fs.readFileSync(path.join(__dirname, '../public/js/' + f), 'utf8');
    vm.runInContext(code, ctx, { filename: f });
  }

  // ждём загрузку boot(): схемы + рендер
  await new Promise(res => setTimeout(res, 900));

  const doc = window.document;
  const paletteItems = doc.querySelectorAll('.pal-item');
  assert.ok(paletteItems.length >= 15, 'палитра не наполнилась: ' + paletteItems.length);
  console.log('✔ палитра:', paletteItems.length, 'блоков');

  assert.ok(doc.querySelectorAll('#schemeSelect option').length >= 2, 'схемы не загрузились');
  console.log('✔ схемы загружены:', doc.querySelectorAll('#schemeSelect option').length);

  const nodes = doc.querySelectorAll('.node');
  assert.ok(nodes.length >= 10, 'узлы демо-схемы не отрисовались: ' + nodes.length);
  console.log('✔ блоков на полигоне:', nodes.length);

  const edges = doc.querySelectorAll('#edges .edge-g');
  assert.ok(edges.length >= 8, 'провода не отрисовались: ' + edges.length);
  console.log('✔ соединений:', edges.length);

  // выбор блока → панель свойств
  const first = doc.querySelector('.node');
  first.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 300, clientY: 100 }));
  window.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, clientX: 300, clientY: 100 }));
  await new Promise(res => setTimeout(res, 100));
  assert.ok(doc.querySelector('#propsBody .pf'), 'панель свойств пуста после выбора блока');
  console.log('✔ панель свойств открывается');

  // компиляция через UI-модалку
  doc.getElementById('btnCompile').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await new Promise(res => setTimeout(res, 700));
  const pre = doc.querySelector('.modal .tabpane pre');
  assert.ok(pre && /exten =>/.test(pre.textContent), 'модалка компиляции не показала диалплан');
  console.log('✔ компиляция из UI, длина extensions.conf:', pre.textContent.length, 'симв.');

  const tabs = [...doc.querySelectorAll('.modal .tab')].map(t => t.textContent);
  console.log('✔ вкладки модалки:', tabs.join(', '));

  console.log('\n✔ UI smoke-тест пройден');
  process.exit(0);
}

main().catch(e => { console.error('✘ UI smoke-тест:', e.message); process.exit(1); });
