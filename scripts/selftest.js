'use strict';
/** Самопроверка: демо-схема компилируется в ожидаемый диалплан. */
const assert = require('assert');
const { compileScheme, compileProject } = require('../server/dialplan');
const seeds = require('../server/seeds');

const registry = seeds.demoRegistry();
const scheme = seeds.demoScheme();

const r = compileScheme(scheme, registry);

const expected = [
  '[gui-demo1-in-1]',
  'exten => s,1',
  'Answer(',
  'Playback(hello)',
  'Background(demo-congrats)',
  'WaitExten(10)',
  'exten => 1,1,Goto(gui-demo1-in-1,s,m_n_dial1)',
  'exten => 2,1,Goto(gui-demo1-in-1,s,m_n_rg)',
  'exten => 0,1,Goto(gui-demo1-in-1,s,m_n_fwd)',
  'exten => t,1,Goto(gui-demo1-in-1,s,m_n_bye)',
  'exten => i,1,Playback(invalid)',
  'Dial(PJSIP/100,25,tT)',
  'Dial(PJSIP/100&PJSIP/101,30,tT)',
  'VoiceMail(100@default,u)',
  'Dial(PJSIP/+79990001122@provider,30,tT)',
  'Playback(goodbye)',
  'Hangup()',
];

console.log('===== extensions (демо-схема) =====');
console.log(r.extensions);
expected.forEach(snippet => {
  assert.ok(r.extensions.includes(snippet), 'ОЖИДАЛОСЬ в диалплане: ' + snippet);
});

// IVR-цикл по таймауту i не подключён — должна быть ссылка назад на IVR:
assert.ok(
  r.extensions.includes('Goto(gui-demo1-in-1,s,m_n_iv)'),
  'неверный ввод IVR должен возвращать в меню'
);

const p = compileProject([scheme], registry);
assert.ok(p.pjsip.includes('type=endpoint'), 'pjsip без endpoint-ов');
assert.ok(p.pjsip.includes('password=' + registry.devices[0].secret), 'секрет абонента не попал в pjsip');
assert.ok(p.extensions.includes('[gui-internal]'), 'нет внутреннего контекста');

console.log('===== предупреждения =====');
console.log(r.warnings.length ? r.warnings.join('\n') : '(нет)');

// схема без точки входа — предупреждение
const empty = compileScheme({ id: 'x1', name: 'Пустая', nodes: [{ id: 'n1', type: 'hangup', x: 0, y: 0, data: {} }], edges: [] }, registry);
assert.ok(empty.warnings.some(w => /точки входа/.test(w)), 'нет предупреждения о точке входа');

// разделённый outbound-маршрут
const outScheme = {
  id: 's2', name: 'Исходящие',
  nodes: [
    { id: 'a', type: 'outbound', x: 0, y: 0, data: { pattern: '_89XXXXXXXXX' } },
    { id: 'b', type: 'outtrunk', x: 200, y: 0, data: { trunk: 'provider', useDialed: true, timeout: 60 } },
    { id: 'c', type: 'hangup', x: 400, y: 0, data: {} },
  ],
  edges: [
    { id: 'e1', from: { node: 'a', port: 'out' }, to: { node: 'b' } },
    { id: 'e2', from: { node: 'b', port: 'out' }, to: { node: 'c' } },
  ],
};
const ro = compileScheme(outScheme, registry);
assert.ok(ro.extensions.includes('exten => _89XXXXXXXXX,1'), 'нет шаблона исходящего');
assert.ok(ro.extensions.includes('Dial(PJSIP/${EXTEN}@provider,60,tT)'), 'нет набора через транк');

console.log('\n✔ Все проверки компилятора пройдены');
