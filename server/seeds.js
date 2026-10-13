'use strict';
/** Демонстрационные данные, создаваемые при первом запуске. */
const crypto = require('crypto');

const secret = () => crypto.randomBytes(9).toString('hex');

function demoRegistry() {
  return {
    devices: [
      { name: 'Менеджер', number: '100', secret: secret(), context: 'gui-internal' },
      { name: 'Ресепшн', number: '101', secret: secret(), context: 'gui-internal' },
    ],
    trunks: [
      {
        name: 'provider', host: 'sip.provider.example', port: 5060,
        username: '', password: '', register: false, inbound: true,
        context: 'gui-demo1-in-1',
      },
    ],
  };
}

function demoScheme() {
  const N = (id, type, x, y, data) => ({ id, type, x, y, data });
  const nodes = [
    N('n_in', 'inbound', 40, 60, { did: 's', trunk: 'provider', recordAll: false }),
    N('n_ans', 'answer', 280, 60, { delay: 0 }),
    N('n_greet', 'playback', 520, 60, { greeting: 'hello', interruptible: false }),
    N('n_iv', 'ivr', 760, 60, {
      greeting: 'demo-congrats', timeout: 10,
      keys: ['1', '2', '0'], useT: true, useI: false,
    }),
    /* ветка 1 — отдел продаж: абонент 100, по неответу голосовая почта */
    N('n_dial1', 'dial', 1060, -140, { device: '100', timeout: 25, options: 'tT' }),
    N('n_vm1', 'voicemail', 1350, -140, { box: '100', context: 'default', mode: 'u', exit: false }),
    /* ветка 2 — группа приёма */
    N('n_rg', 'ringgroup', 1060, 60, { mode: 'par', timeout: 30, members: ['100', '101'] }),
    N('n_vm2', 'voicemail', 1350, 60, { box: '101', context: 'default', mode: 'u', exit: false }),
    /* ветка 0 — переадресация на мобильный через транк */
    N('n_fwd', 'forward', 1060, 260, { number: '+79990001122', trunk: 'provider', timeout: 30 }),
    /* таймаут меню */
    N('n_bye', 'playback', 1060, 460, { greeting: 'goodbye', interruptible: false }),
    N('n_hang', 'hangup', 1350, 460, { cause: '' }),
  ];
  const E = (f, fp, t) => ({ id: 'e' + Math.random().toString(36).slice(2, 9), from: { node: f, port: fp }, to: { node: t } });
  const edges = [
    E('n_in', 'out', 'n_ans'),
    E('n_ans', 'out', 'n_greet'),
    E('n_greet', 'out', 'n_iv'),
    E('n_iv', 'k1', 'n_dial1'),
    E('n_dial1', 'out', 'n_vm1'),
    E('n_iv', 'k2', 'n_rg'),
    E('n_rg', 'out', 'n_vm2'),
    E('n_iv', 'k0', 'n_fwd'),
    E('n_fwd', 'out', 'n_hang'),
    E('n_iv', 'kt', 'n_bye'),
    E('n_bye', 'out', 'n_hang'),
  ];
  return {
    id: 'demo1',
    name: 'Демо · Входящий вызов',
    description: 'Пример: приветствие → IVR-меню (1 — продажи, 2 — приёмная, 0 — мобильный).',
    nodes, edges,
    updatedAt: new Date().toISOString(),
  };
}

function demoSchemeOutbound() {
  const N = (id, type, x, y, data) => ({ id, type, x, y, data });
  const nodes = [
    N('o_start', 'outbound', 60, 80, { pattern: '_89XXXXXXXXX' }),
    N('o_cid', 'setcallerid', 330, 80, { number: '74951234567', name: '' }),
    N('o_rec', 'record', 590, 80, { mode: 'start', name: 'out', append: false }),
    N('o_trunk', 'outtrunk', 850, 80, { trunk: 'provider', useDialed: true, timeout: 60 }),
    N('o_busy', 'busy', 1150, 80, { seconds: 5 }),
  ];
  const E = (f, fp, t) => ({ id: 'e' + Math.random().toString(36).slice(2, 9), from: { node: f, port: fp }, to: { node: t } });
  const edges = [
    E('o_start', 'out', 'o_cid'),
    E('o_cid', 'out', 'o_rec'),
    E('o_rec', 'out', 'o_trunk'),
    E('o_trunk', 'out', 'o_busy'),
  ];
  return {
    id: 'demo2',
    name: 'Демо · Исходящий маршрут',
    description: 'Мобильные (89…) → запись разговора → транк провайдера; по неответу — «занято».',
    nodes, edges,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { demoRegistry, demoScheme, demoSchemeOutbound };
