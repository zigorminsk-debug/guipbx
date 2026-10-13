/**
 * Смоук-тест FlowPBX: страница реально загружается и основные сценарии работают.
 *
 * Тест поднимает собранный `dist/index.html` (или исходный — через
 * `SMOKE_TARGET=index.html`) в jsdom, выполняет встроенный JS и проверяет
 * ключевые сценарии прототипа: старт, переключение маршрутов, инспектор,
 * экспорт dialplan, валидацию схемы, добавление блока, undo и автосохранение.
 *
 * Браузер не скачивается: прототип не зависит от layout/pointer-событий
 * в проверяемых сценариях, поэтому jsdom даёт быстрый и детерминированный
 * прогон в CI (~2 c).
 *
 * Запуск: npm test
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(
  ROOT,
  process.env.SMOKE_TARGET ?? (existsSync(join(ROOT, 'dist/index.html')) ? 'dist/index.html' : 'index.html'),
);

/** Ключ, под которым прототип хранит схемы в localStorage. */
const STORAGE_KEY = 'flowpbx-demo-v1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Загружает страницу в jsdom и возвращает «пульт» для теста.
 * Все ошибки скриптов и console.error собираются в массив errors.
 *
 * @param {{ storage?: string }} [options] storage — заранее записанная схема:
 *        так проверяем восстановление состояния из localStorage.
 */
async function boot({ storage } = {}) {
  const html = readFileSync(TARGET, 'utf8');
  const errors = [];

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(`jsdomError: ${error.message}`));
  virtualConsole.on('error', (...args) => errors.push(`console.error: ${args.join(' ')}`));

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://flowpbx.test/',
    virtualConsole,
    beforeParse(window) {
      // Пробелы jsdom, а не приложения: structuredClone и scrollIntoView
      // в jsdom не реализованы, в реальных браузерах они есть.
      if (typeof window.structuredClone !== 'function') {
        window.structuredClone = (value) => structuredClone(value);
      }
      if (typeof window.Element.prototype.scrollIntoView !== 'function') {
        window.Element.prototype.scrollIntoView = function scrollIntoViewStub() {};
      }
      if (storage) window.localStorage.setItem(STORAGE_KEY, storage);
      window.addEventListener('error', (event) => errors.push(`uncaught: ${event.message}`));
      window.addEventListener('unhandledrejection', (event) => errors.push(`unhandled rejection: ${event.reason}`));
    },
  });

  const { window } = dom;
  await Promise.race([
    new Promise((r) => window.addEventListener('load', r, { once: true })),
    sleep(5000),
  ]);
  await sleep(50); // даём отработать отложенным задачам приложения

  const document = window.document;
  const byId = (id) => document.getElementById(id);
  const q = (selector) => document.querySelector(selector);
  const qa = (selector) => [...document.querySelectorAll(selector)];
  const text = (selectorOrId) => (byId(selectorOrId) ?? q(selectorOrId))?.textContent?.trim();

  const fire = (target, type, Ctor = window.MouseEvent) => {
    assert.ok(target, `не найден элемент для события ${type}`);
    target.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
  };
  const click = (selectorOrEl) => fire(typeof selectorOrEl === 'string' ? q(selectorOrEl) ?? byId(selectorOrEl) : selectorOrEl, 'click');

  const nodes = () => qa('[data-node-id]');
  const closeModals = () => qa('[data-modal-action="close"]').forEach((btn) => fire(btn, 'click'));

  return {
    window,
    document,
    byId,
    q,
    qa,
    text,
    click,
    fire,
    nodes,
    closeModals,
    errors,
    sleep,
    close: () => window.close(),
  };
}

describe(`FlowPBX: ${TARGET.replace(`${ROOT}/`, '')}`, () => {
  describe('загрузка и стартовое состояние', () => {
    let app;

    before(async () => {
      app = await boot();
    });
    after(() => app?.close());

    it('страница запускается без ошибок скриптов', () => {
      assert.deepEqual(app.errors, []);
    });

    it('заголовок и язык на месте', () => {
      assert.match(app.document.title, /FlowPBX/);
      assert.equal(app.document.documentElement.getAttribute('lang'), 'ru');
    });

    it('рендерит стартовый маршрут «Входящий»', () => {
      assert.equal(app.text('canvasTitle'), 'Входящий маршрут');
      assert.equal(app.nodes().length, 7);
      assert.match(app.text('canvasMeta'), /7 блоков · 9 связей/);
      assert.equal(app.text('canvasFooterCount'), '7 блоков');
      assert.match(app.text('saveState'), /сохранены локально/i);
    });

    it('заполняет библиотеку блоков и инспектор', () => {
      assert.ok(app.qa('[data-add-type]').length >= 12, 'в библиотеке должно быть не менее 12 блоков');
      assert.ok(app.text('paletteCount').length > 0);
      assert.ok(app.text('inspectorBody').length > 0, 'инспектор пуст для выбранного блока');
      assert.ok(app.qa('#inspectorBody [data-property]').length > 0, 'в инспекторе нет редактируемых свойств');
    });

    it('рисует связи на svg-слое', () => {
      assert.ok(app.qa('#edgesSvg path, #edgesSvg line').length >= 9, 'ожидаются линии связей');
    });

    it('переключает маршруты вкладками', () => {
      app.click('[data-flow-tab="outbound"]');
      assert.equal(app.text('canvasTitle'), 'Исходящий маршрут');
      assert.equal(app.nodes().length, 5);

      app.click('[data-flow-tab="transfer"]');
      assert.equal(app.nodes().length, 4);

      app.click('[data-flow-tab="inbound"]');
      assert.equal(app.text('canvasTitle'), 'Входящий маршрут');
      assert.equal(app.nodes().length, 7);
    });

    it('переключает вкладки инспектора', () => {
      app.click('[data-inspector-tab="connections"]');
      assert.match(app.text('inspectorMode'), /ПЕРЕХОДЫ|СВЯЗ/i);
      app.click('[data-inspector-tab="properties"]');
      assert.match(app.text('inspectorMode'), /СВОЙСТВА/i);
    });

    it('фильтрует библиотеку поиском', () => {
      const total = app.qa('[data-add-type]').length;
      const search = app.byId('paletteSearch');
      search.value = 'очередь';
      app.fire(search, 'input', app.window.Event);
      const found = app.qa('[data-add-type]').length;
      assert.ok(found > 0 && found < total, `поиск должен сузить список (было ${total}, стало ${found})`);

      search.value = '';
      app.fire(search, 'input', app.window.Event);
      assert.equal(app.qa('[data-add-type]').length, total);
    });

    it('меняет масштаб кнопками зума', () => {
      const before = app.text('zoomValue');
      app.click('zoomInBtn');
      const after = app.text('zoomValue');
      assert.notEqual(after, before);
      assert.match(after, /^\d+%$/);
      app.click('zoomOutBtn');
      assert.equal(app.text('zoomValue'), before);
    });

    it('показывает пример extensions.conf', () => {
      app.click('codeBtn');
      const code = app.byId('codeText');
      assert.ok(code, 'модальное окно с кодом не открылось');
      const contexts = code.textContent.match(/^\[[a-z0-9_-]+\]$/gm) ?? [];
      assert.ok(contexts.length >= 3, `ожидаются контексты dialplan, получено ${contexts.length}`);
      assert.match(code.textContent, /^\s*exten => /m, 'ожидаются строки exten =>');
      assert.match(code.textContent, /same\s*=>/, 'ожидаются шаги same => n');
      app.closeModals();
      assert.equal(app.byId('modalRoot').children.length, 0, 'модальное окно не закрылось');
    });

    it('проверяет схему валидатором', () => {
      app.click('validateBtn');
      assert.match(app.text('modalRoot'), /Проверка маршрута/);
      app.closeModals();
    });

    it('по-прежнему без ошибок после всех сценариев', () => {
      assert.deepEqual(app.errors, []);
    });
  });

  describe('редактирование схемы и сохранение', () => {
    let app;
    let initial;

    before(async () => {
      app = await boot();
      initial = app.nodes().length;
    });
    after(() => app?.close());

    it('добавляет блок из библиотеки', () => {
      app.click('[data-add-type="hangup"]');
      assert.equal(app.nodes().length, initial + 1);
      assert.match(app.text('canvasFooterCount'), new RegExp(`${initial + 1} блоков`));
    });

    it('разрешает отмену действия', () => {
      assert.equal(app.byId('undoBtn').disabled, false, 'кнопка «Отменить» должна стать активной');
      app.click('undoBtn');
      assert.equal(app.nodes().length, initial);
    });

    it('сохраняет схему в localStorage', async () => {
      app.click('[data-add-type="voicemail"]');
      await app.sleep(500); // debounce автосохранения — 240 мс

      const raw = app.window.localStorage.getItem(STORAGE_KEY);
      assert.ok(raw, 'схема не сохранена в localStorage');
      const flows = JSON.parse(raw);
      assert.ok(flows.inbound && flows.outbound && flows.transfer, 'в сохранённой схеме нет трёх маршрутов');
      assert.equal(flows.inbound.nodes.length, initial + 1);
      assert.ok(flows.inbound.nodes.some((node) => node.type === 'voicemail'), 'добавленный блок не сохранён');
      assert.match(app.text('saveState'), /сохранены локально/i);
    });

    it('восстанавливает сохранённую схему при повторной загрузке', async () => {
      const saved = app.window.localStorage.getItem(STORAGE_KEY);
      assert.ok(saved, 'нет сохранённой схемы для проверки восстановления');

      const restored = await boot({ storage: saved });
      assert.equal(restored.nodes().length, initial + 1, 'сохранённая схема не восстановилась');
      assert.deepEqual(restored.errors, []);
      restored.close();
    });

    it('без ошибок в конце', () => {
      assert.deepEqual(app.errors, []);
    });
  });
});
