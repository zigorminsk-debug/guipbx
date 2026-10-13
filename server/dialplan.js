'use strict';
/**
 * Компилятор визуальной карты вызова в диалплан Asterisk.
 *
 * Вход: схема { nodes, edges } (как нарисовано на полигоне) + реестр устройств/транков.
 * Выход: extensions.conf-контексты, pjsip.conf, вспомогательные конфиги (queues.conf),
 *        список предупреждений о проблемах в схеме.
 *
 * Принцип: каждый блок схемы становится набором приоритетов внутри контекста,
 * каждый соединитель на полигоне — командой Goto/переходом. Ветвления (IVR,
 * условие времени, логическое условие) порождают именованные приоритеты.
 */

const SAFE = s => String(s == null ? '' : s).replace(/[()\[\]$;,]/g, ' ').replace(/\s+/g, ' ').trim();

/** Русские названия блоков для читаемых NoOp-меток в диалплане. */
const TITLES = {
  inbound: 'Входящий вызов', outbound: 'Исходящий маршрут', answer: 'Ответить',
  playback: 'Воспроизвести', ivr: 'IVR-меню', record: 'Запись разговора', wait: 'Пауза',
  setcallerid: 'Изменить CallerID', setvar: 'Переменная', curl: 'HTTP-запрос', log: 'Лог',
  time: 'Условие времени', condition: 'Условие', dial: 'Вызов абонента', ringgroup: 'Группа вызова',
  queue: 'Очередь', conference: 'Конференция', voicemail: 'Голосовая почта', forward: 'Переадресация',
  outtrunk: 'Внешний номер (транк)', park: 'Парковка', busy: 'Сигнал занято', hangup: 'Завершить вызов',
  custom: 'Своя команда',
};

/** Имя именованного приоритета для блока. */
function labelOf(node) {
  return 'm_' + String(node.id).replace(/[^a-zA-Z0-9_]/g, '');
}

function nodeTitle(node) {
  return TITLES[node.type] || node.type;
}

/**
 * Компиляция одной схемы.
 * @param {object} scheme  { id, name, nodes: [{id,type,x,y,data}], edges: [{from:{node,port},to:{node}}] }
 * @param {object} registry { devices: [], trunks: [] }
 * @returns {{extensions:string, warnings:string[], used:{queues:string[],trunks:string[],devices:string[]}}}
 */
function compileScheme(scheme, registry) {
  const warnings = [];
  const nodes = Array.isArray(scheme.nodes) ? scheme.nodes : [];
  const edges = Array.isArray(scheme.edges) ? scheme.edges : [];
  const byId = {};
  nodes.forEach(n => (byId[n.id] = n));

  const used = { queues: new Set(), trunks: new Set(), devices: new Set() };

  // --- служебные функции по графу -----------------------------------------
  const outTarget = (nodeId, portId) => {
    const e = edges.find(e => e.from.node === nodeId && (portId == null || e.from.port === portId));
    return e ? byId[e.to.node] || null : null;
  };
  const entries = nodes.filter(n => n.type === 'inbound' || n.type === 'outbound');
  if (entries.length === 0) {
    warnings.push('В схеме нет точки входа («Входящий вызов» / «Исходящий маршрут») — контекст не будет сгенерирован.');
  }

  const sections = [];

  // --- генерация одного контекста от точки входа ---------------------------
  function emitContext(C, entry, index) {
    const isOut = entry.type === 'outbound';
    C.ctx = `gui-${scheme.id}-${isOut ? 'out' : 'in'}-${index + 1}`;
    C.exten = isOut ? (entry.data.pattern || '_X.') : (entry.data.did || 's');
    C.lines = [];
    C.first = true;
    C.emitted = new Set();
    C.ivrCount = 0;

    C.header.push(
      '',
      `; ──────────────────────────────────────────────────────────────`,
      `; Схема: ${SAFE(scheme.name)}  ·  точка входа #${index + 1} (${isOut ? 'исходящий маршрут' : 'входящий вызов'})`,
      `; ──────────────────────────────────────────────────────────────`,
      `[${C.ctx}]`
    );

    emitNode(C, entry);

    // узлы, недостижимые из этой точки входа (в рамках всей схемы)
    sections.push(C.header.concat(C.lines).join('\n'));
    C.emittedSet = C.emitted;
  }

  function push(C, action, label) {
    const tag = C.first ? `exten => ${C.exten},1` : 'same => n';
    C.lines.push(label ? `${tag}(${label}),${action}` : `${tag},${action}`);
    C.first = false;
  }

  function sayNode(C, node) {
    push(C, `NoOp(>>> ${SAFE(nodeTitle(node))})`, labelOf(node));
  }

  function goto(C, targetNode) {
    push(C, `Goto(${C.ctx},${C.exten},${labelOf(targetNode)})`);
  }

  /** Линейный переход по порту "out"; возвращает следующий узел или null. */
  function next(C, node, portId) {
    const t = outTarget(node.id, portId || 'out');
    if (!t) {
      push(C, 'Hangup()');
      C.warnings.push(`Блок «${nodeTitle(node)}»: выход не подключён — ветка завершена Hangup().`);
      return null;
    }
    return t;
  }

  function emitNode(C, node) {
    if (!node) return;
    let cur = node;

    // цикл по линейной цепочке блоков, пока не встретим ветвление/терминал;
    // каждый эмитированный узел регистрируется, повторный вход — через Goto на метку
    while (cur) {
      if (C.emitted.has(cur.id)) { goto(C, cur); return; }
      C.emitted.add(cur.id);
      const dd = cur.data || {};
      sayNode(C, cur);
      switch (cur.type) {
        case 'inbound':
          if (dd.trunk) push(C, `NoOp(Транк: ${SAFE(dd.trunk)})`);
          push(C, 'Set(CHANNEL(language)=ru)');
          if (dd.recordAll) push(C, `Set(__REC_FILE=/var/spool/asterisk/monitor/\${STRFTIME(\${EPOCH},,%Y%m%d-%H%M%S)}-\${CALLERID(num)}.wav)`);
          cur = next(C, cur); break;

        case 'outbound':
          push(C, 'Set(__OUTNUM=${EXTEN})');
          if (dd.recPrefix) push(C, `NoOp(Префикс маршрута: ${SAFE(dd.recPrefix)})`);
          cur = next(C, cur); break;

        case 'answer':
          push(C, `Answer(${Number(dd.delay) > 0 ? Number(dd.delay) * 1000 : ''})`);
          cur = next(C, cur); break;

        case 'playback': {
          const g = dd.greeting || 'hello';
          push(C, dd.interruptible ? `Background(${SAFE(g)})` : `Playback(${SAFE(g)})`);
          cur = next(C, cur); break;
        }

        case 'record':
          if (String(dd.mode) === 'stop') push(C, 'StopMixMonitor()');
          else push(C, `MixMonitor(\${UNIQUEID}-${SAFE(dd.name || 'call')}.wav,${dd.append ? 'a' : ''})`);
          cur = next(C, cur); break;

        case 'wait':
          push(C, `Wait(${Number(dd.seconds) > 0 ? Number(dd.seconds) : 1})`);
          cur = next(C, cur); break;

        case 'setcallerid': {
          const num = dd.number || '${CALLERID(num)}';
          const name = dd.name ? SAFE(dd.name) : '${CALLERID(name)}';
          push(C, `Set(CALLERID(all)=${name} <${SAFE(num)}>)`);
          cur = next(C, cur); break;
        }

        case 'setvar':
          push(C, `Set(${dd.name ? SAFE(dd.name) : 'MYVAR'}=${SAFE(dd.value)})`);
          cur = next(C, cur); break;

        case 'log':
          push(C, `Log(NOTICE, ${SAFE(dd.text || 'marker')})`);
          cur = next(C, cur); break;

        case 'curl':
          push(C, `Set(CURLRES=\${CURL(${String(dd.url || 'http://').replace(/[()]/g, '')})})`);
          cur = next(C, cur); break;

        case 'custom':
          if (!dd.app) C.warnings.push('«Своя команда»: не указано приложение Asterisk.');
          push(C, `${SAFE(dd.app) || 'NoOp'}(${dd.args || ''})`);
          cur = next(C, cur); break;

        case 'ivr': {
          C.ivrCount++;
          if (C.ivrCount > 1) C.warnings.push('В одной схеме несколько IVR-меню: их цифровые extension-ы будут конфликтовать внутри контекста.');
          push(C, `Background(${SAFE(dd.greeting || 'demo-congrats')})`);
          push(C, `WaitExten(${Number(dd.timeout) > 0 ? Number(dd.timeout) : 10})`);
          push(C, 'Hangup()');
          const keys = Array.isArray(dd.keys) ? dd.keys : [];
          keys.forEach(k => {
            const t = outTarget(cur.id, 'k' + k);
            if (t) C.lines.push(`exten => ${k},1,Goto(${C.ctx},${C.exten},${labelOf(t)})`);
            else {
              C.lines.push(`exten => ${k},1,Playback(invalid)`, `same => n,Goto(${C.ctx},${C.exten},${labelOf(cur)})`);
              C.warnings.push(`IVR: клавиша «${k}» не подключена — повтор меню.`);
            }
          });
          const tT = dd.useT ? outTarget(cur.id, 'kt') : null;
          C.lines.push(tT ? `exten => t,1,Goto(${C.ctx},${C.exten},${labelOf(tT)})` : 'exten => t,1,Hangup()');
          const tI = dd.useI ? outTarget(cur.id, 'ki') : null;
          if (tI) C.lines.push(`exten => i,1,Goto(${C.ctx},${C.exten},${labelOf(tI)})`);
          else C.lines.push(`exten => i,1,Playback(invalid)`, `same => n,Goto(${C.ctx},${C.exten},${labelOf(cur)})`);
          // рекурсивно эмитим ветки клавиш
          keys.forEach(k => { const t = outTarget(cur.id, 'k' + k); if (t && !C.emitted.has(t.id)) emitNode(C, t); });
          if (tT && !C.emitted.has(tT.id)) emitNode(C, tT);
          if (tI && !C.emitted.has(tI.id)) emitNode(C, tI);
          return;
        }

        case 'time': {
          const span = `${dd.start || '09:00'}-${dd.end || '18:00'}`;
          const dow = dd.days || 'mon-fri';
          const jmp = `${C.ctx},${C.exten},`;
          const tYes = outTarget(cur.id, 'match');
          const tNo = outTarget(cur.id, 'nomatch');
          if (!tYes && !tNo) { C.warnings.push('«Условие времени»: оба выхода не подключены — ветка завершена Hangup().'); push(C, 'Hangup()'); return; }
          if (tYes && tNo) {
            push(C, `GotoIfTime(${span},${dow},*,*?${jmp}${labelOf(tYes)})`);
            push(C, `Goto(${jmp}${labelOf(tNo)})`);
          } else if (tYes) {
            push(C, `GotoIfTime(${span},${dow},*,*?${jmp}${labelOf(tYes)})`);
            push(C, 'Hangup()');
            C.warnings.push('«Условие времени»: выход «не входит» не подключён — ночью вызов завершится Hangup().');
          } else {
            const fb = labelOf(cur) + '_th';
            push(C, `GotoIfTime(${span},${dow},*,*?${jmp}${fb})`);
            push(C, `Goto(${jmp}${labelOf(tNo)})`);
            push(C, 'Hangup()', fb);
            C.warnings.push('«Условие времени»: выход «входит» не подключён — по совпадению вызов завершится Hangup().');
          }
          if (tYes && !C.emitted.has(tYes.id)) emitNode(C, tYes);
          if (tNo && !C.emitted.has(tNo.id)) emitNode(C, tNo);
          return;
        }

        case 'condition': {
          const expr = String(dd.expr || '1=1').replace(/[()]/g, '');
          const jmp = `${C.ctx},${C.exten},`;
          const tYes = outTarget(cur.id, 'yes');
          const tNo = outTarget(cur.id, 'no');
          if (!tYes && !tNo) { C.warnings.push('«Условие»: оба выхода не подключены — ветка завершена Hangup().'); push(C, 'Hangup()'); return; }
          if (tYes && tNo) {
            push(C, `GotoIf($[${expr}]?${jmp}${labelOf(tYes)})`);
            push(C, `Goto(${jmp}${labelOf(tNo)})`);
          } else if (tYes) {
            push(C, `GotoIf($[${expr}]?${jmp}${labelOf(tYes)})`);
            push(C, 'Hangup()');
            C.warnings.push('«Условие»: выход «нет» не подключён — вызов завершится Hangup().');
          } else {
            const fb = labelOf(cur) + '_th';
            push(C, `GotoIf($[${expr}]?${jmp}${fb})`);
            push(C, `Goto(${jmp}${labelOf(tNo)})`);
            push(C, 'Hangup()', fb);
            C.warnings.push('«Условие»: выход «да» не подключён — по истине вызов завершится Hangup().');
          }
          if (tYes && !C.emitted.has(tYes.id)) emitNode(C, tYes);
          if (tNo && !C.emitted.has(tNo.id)) emitNode(C, tNo);
          return;
        }

        case 'dial': {
          const dev = (dd.device || '').trim();
          if (!dev) C.warnings.push('«Вызов абонента»: не выбран номер устройства.');
          else C.usedDevices.add(dev);
          push(C, `Dial(PJSIP/${SAFE(dev) || 'UNDEFINED'},${Number(dd.timeout) > 0 ? Number(dd.timeout) : 30},${dd.options || 'tT'})`);
          cur = next(C, cur); break;
        }

        case 'ringgroup': {
          const members = (Array.isArray(dd.members) ? dd.members : []).filter(Boolean);
          if (members.length === 0) C.warnings.push('«Группа вызова»: пустой список участников.');
          members.forEach(m => C.usedDevices.add(m));
          const t = Number(dd.timeout) > 0 ? Number(dd.timeout) : 25;
          if (dd.mode === 'seq') {
            members.forEach(m => push(C, `Dial(PJSIP/${SAFE(m)},${t},tT)`));
          } else {
            push(C, `Dial(${members.map(m => 'PJSIP/' + SAFE(m)).join('&')},${t},tT)`);
          }
          cur = next(C, cur); break;
        }

        case 'queue':
          if (!dd.name) C.warnings.push('«Очередь»: не указано имя очереди.');
          else C.usedQueues.add(dd.name);
          push(C, `Queue(${SAFE(dd.name) || 'support'},${dd.options || 't'},,,${Number(dd.timeout) > 0 ? Number(dd.timeout) : ''})`);
          cur = next(C, cur); break;

        case 'conference':
          if (!dd.room) C.warnings.push('«Конференция»: не указан номер комнаты.');
          push(C, `ConfBridge(${SAFE(dd.room) || '900'}${dd.pin ? ',' + SAFE(dd.pin) : ''})`);
          cur = next(C, cur); break;

        case 'voicemail':
          if (!dd.box) C.warnings.push('«Голосовая почта»: не указан ящик.');
          push(C, `VoiceMail(${SAFE(dd.box) || '100'}@${SAFE(dd.context) || 'default'},${dd.mode || 'u'})`);
          cur = dd.exit ? next(C, cur) : (push(C, 'Hangup()'), null); break;

        case 'forward': {
          const num = (dd.number || '').trim();
          const trunk = (dd.trunk || '').trim();
          if (!num) C.warnings.push('«Переадресация»: не задан номер назначения.');
          if (!trunk) C.warnings.push('«Переадресация»: не выбран транк.');
          if (trunk) C.usedTrunks.add(trunk);
          const dest = num === '$DIALED' ? '${EXTEN}' : SAFE(num);
          push(C, `Dial(PJSIP/${dest || 'UNKNOWN'}@${SAFE(trunk) || 'trunk'},${Number(dd.timeout) > 0 ? Number(dd.timeout) : 30},tT)`);
          cur = next(C, cur); break;
        }

        case 'outtrunk': {
          const trunk = (dd.trunk || '').trim();
          if (!trunk) C.warnings.push('«Внешний номер (транк)»: транк не выбран.');
          if (trunk) C.usedTrunks.add(trunk);
          const dest = dd.useDialed !== false ? '${EXTEN}' : SAFE(dd.number);
          push(C, `Dial(PJSIP/${dest}@${SAFE(trunk) || 'trunk'},${Number(dd.timeout) > 0 ? Number(dd.timeout) : 60},tT)`);
          cur = next(C, cur); break;
        }

        case 'park':
          push(C, 'Park()');
          return;

        case 'busy':
          push(C, `Busy(${Number(dd.seconds) > 0 ? Number(dd.seconds) : ''})`);
          push(C, 'Hangup()');
          return;

        case 'hangup':
          push(C, `Hangup(${dd.cause ? SAFE(dd.cause) : ''})`);
          return;

        default:
          push(C, `NoOp(Неизвестный блок: ${cur.type})`);
          C.warnings.push(`Тип блока «${cur.type}» неизвестен компилятору — пропущен как NoOp.`);
          cur = next(C, cur); break;
      }
    }
  }

  /** Прокидываем выбранные компилятору реестры для валидации. */
  const C = {
    header: [], lines: [], warnings,
    usedQueues: used.queues, usedDevices: used.devices, usedTrunks: used.trunks,
  };

  entries.forEach((entry, i) => emitContext(C, entry, i));

  // недостижимые узлы
  const emittedAll = new Set();
  // пересоберём достижимость из всех контекстов: пометим всё, что эмитилось
  // (упрощённо: достижимый узел — тот, до которого есть путь от любого entry)
  const reach = new Set();
  const stack = entries.map(e => e.id);
  while (stack.length) {
    const id = stack.pop();
    if (reach.has(id)) continue;
    reach.add(id);
    edges.filter(e => e.from.node === id).forEach(e => stack.push(e.to.node));
  }
  nodes.filter(n => !reach.has(n.id)).forEach(n =>
    warnings.push(`Блок «${nodeTitle(n)}» не связан ни с одной точкой входа — не попадёт в диалплан.`));

  return {
    extensions: sections.join('\n') + '\n',
    warnings,
    used: {
      queues: [...used.queues],
      trunks: [...used.trunks],
      devices: [...used.devices],
    },
  };
}

/** pjsip.conf по реестру устройств (внутренние SIP-абоненты) и транков. */
function compilePjsip(registry) {
  const out = [
    '; ══════════════════════════════════════════════════════════════',
    '; pjsip.conf — сгенерировано GUIPBX',
    '; Подключите: #include этого файла в /etc/asterisk/pjsip.conf',
    '; ══════════════════════════════════════════════════════════════',
    '',
    '[transport-udp]',
    'type=transport',
    'protocol=udp',
    'bind=0.0.0.0:5060',
    '',
  ];

  (registry.devices || []).forEach(dev => {
    out.push(
      `; ----- Абонент ${dev.number} · ${SAFE(dev.name)} -----`,
      `[${dev.number}]`,
      'type=endpoint',
      `context=${dev.context || 'gui-internal'}`,
      'disallow=all',
      'allow=ulaw,alaw,opus',
      `auth=${dev.number}`,
      `aors=${dev.number}`,
      '',
      `[${dev.number}]`,
      'type=auth',
      'auth_type=userpass',
      `username=${dev.number}`,
      `password=${dev.secret}`,
      '',
      `[${dev.number}]`,
      'type=aor',
      'max_contacts=1',
      '',
    );
  });

  (registry.trunks || []).forEach(tr => {
    const n = SAFE(tr.name) || 'trunk';
    out.push(`; ----- Транк «${n}» · ${SAFE(tr.host)} -----`);
    if (tr.register) {
      out.push(
        `[${n}-reg]`,
        'type=registration',
        'transport=transport-udp',
        'outbound_auth=' + n,
        `server_uri=sip:${tr.host}${tr.port ? ':' + tr.port : ''}`,
        `client_uri=sip:${tr.username || 'user'}@${tr.host}`,
        'retry_interval=60',
        '',
      );
    }
    if (tr.username) {
      out.push(
        `[${n}]`,
        'type=auth',
        'auth_type=userpass',
        `username=${tr.username}`,
        `password=${tr.password || ''}`,
        '',
      );
    }
    out.push(
      `[${n}]`,
      'type=aor',
      `contact=sip:${tr.host}${tr.port ? ':' + tr.port : ''}`,
      '',
      `[${n}]`,
      'type=endpoint',
      `context=${tr.context || 'gui-in-1'}`,
      'disallow=all',
      'allow=ulaw,alaw',
      `aors=${n}`,
    );
    if (tr.username) out.push(`outbound_auth=${n}`);
    out.push('from_user=' + (tr.username || ''), 'from_domain=' + (tr.host || ''), '');
    if (tr.inbound) {
      out.push(
        `[${n}]`,
        'type=identify',
        `endpoint=${n}`,
        `match=${tr.host}`,
        '',
      );
    }
  });

  return out.join('\n');
}

/**
 * Внутренний контекст для локальных абонентов: звонки друг другу
 * + автоматические include всех исходящих маршрутов из всех схем.
 */
function compileInternal(registry, schemes) {
  const devs = (registry.devices || []).map(d => d.number);
  const lines = [
    '; Внутренние звонки между зарегистрированными абонентами',
    '[gui-internal]',
    ...devs.map(n => `exten => ${n},1,Dial(PJSIP/${n},30,tT)`),
  ];
  if (devs.length) lines.push('same => n,Hangup()');
  const outIncludes = [];
  (schemes || []).forEach(sc => {
    (sc.nodes || []).filter(n => n.type === 'outbound').forEach((n, i) => {
      outIncludes.push(`include => gui-${sc.id}-out-${i + 1}`);
    });
  });
  if (outIncludes.length) {
    lines.push('', '; Исходящие маршруты, нарисованные на картах:');
    outIncludes.forEach(i => lines.push(i));
  }
  return lines.join('\n') + '\n';
}

/** queues.conf для очередей, использованных в схемах. */
function compileQueues(names, registry) {
  if (!names.length) return null;
  const members = (registry.devices || []).map(d => d.number);
  const out = ['; queues.conf — очереди, использованные в схемах GUIPBX', '[general]', 'persistentmembers = yes', ''];
  names.forEach(q => {
    out.push(`[${q}]`, 'strategy = ringall', 'timeout = 15', 'retry = 5', 'maxlen = 0');
    members.forEach(m => out.push(`member => PJSIP/${m}`));
    out.push('');
  });
  return out.join('\n');
}

/** Полная сборка проекта: все схемы + реестр. */
function compileProject(schemes, registry) {
  const allWarnings = [];
  const parts = [
    '; ╔══════════════════════════════════════════════════════════════╗',
    '; ║  extensions_gui.conf — сгенерировано GUIPBX ' + new Date().toISOString() + ' ║',
    '; ║  НЕ редактируйте вручную — файл перезаписывается из редактора ║',
    '; ╚══════════════════════════════════════════════════════════════╝',
    '',
    '[general]',
    '[globals]',
  ];
  const queueNames = new Set();
  const usedTrunks = new Set();

  const usedDevices = new Set();
  schemes.forEach(sc => {
    const r = compileScheme(sc, registry);
    r.warnings.forEach(w => allWarnings.push(`[${sc.name}] ${w}`));
    r.used.queues.forEach(q => queueNames.add(q));
    r.used.trunks.forEach(t => usedTrunks.add(t));
    r.used.devices.forEach(d => usedDevices.add(d));
    parts.push(r.extensions);
  });

  parts.push(compileInternal(registry, schemes));

  // валидация транков/устройств
  const trNames = new Set((registry.trunks || []).map(t => t.name));
  [...usedTrunks].filter(t => !trNames.has(t)).forEach(t =>
    allWarnings.push(`Используется транк «${t}», отсутствующий в реестре транков.`));
  const devNums = new Set((registry.devices || []).map(d => String(d.number)));
  [...usedDevices].filter(d => !devNums.has(String(d))).forEach(d =>
    allWarnings.push(`Используется абонент «${d}», отсутствующий в реестре устройств.`));

  const queues = compileQueues([...queueNames], registry);

  return {
    extensions: parts.join('\n'),
    pjsip: compilePjsip(registry),
    queues,
    warnings: allWarnings,
    knownDevices: [...devNums],
  };
}

module.exports = { compileScheme, compilePjsip, compileProject, compileQueues };
