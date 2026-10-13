'use strict';
/**
 * Реестр блоков палитры: точки входа, действия, устройства, логика.
 * Каждый блок: порты (входы/выходы), поля настроек, краткое описание на узле.
 */
(function () {
  const GREETINGS = [
    'hello', 'demo-congrats', 'demo-thanks', 'goodbye', 'invalid', 'transfer',
    'pls-wait-connect-call', 'queue-youarenext', 'agent-pass', 'privacy-prompt',
  ];
  const DOW = [
    ['mon-fri', 'пн–пт'], ['mon-sat', 'пн–сб'], ['mon-sun', 'все дни'],
    ['sat-sun', 'сб–вс'], ['mon', 'пн'], ['tue', 'вт'], ['wed', 'ср'], ['thu', 'чт'], ['fri', 'пт'], ['sat', 'сб'], ['sun', 'вс'],
  ];

  /** @typedef {{id:string,label:string}} Port */

  const DEFS = {
    /* ══ ТОЧКИ ВХОДА ══ */
    inbound: {
      title: 'Входящий вызов', icon: '📞', cat: 'entry', color: '#22c55e',
      desc: 'Старт обработки внешнего вызова (с транка)',
      inputs: 0,
      outputs: [{ id: 'out', label: '▶ старт' }],
      fields: [
        { key: 'did', label: 'Внешний номер / DID-шаблон', type: 'text', default: 's', help: 's — любой входящий; точный номер (74951234567) или шаблон Asterisk (_7495XXXXXXX)' },
        { key: 'trunk', label: 'Транк (комментарий)', type: 'trunkref', default: '', help: 'Информационно. Реальный контекст назначается в pjsip-эндпоинте транка' },
        { key: 'recordAll', label: 'Готовить файл записи вызова', type: 'checkbox', default: false },
      ],
      summary: d => ['DID: ' + (d.did || 's')].concat(d.trunk ? ['транк: ' + d.trunk] : []),
    },
    outbound: {
      title: 'Исходящий маршрут', icon: '📤', cat: 'entry', color: '#f59e0b',
      desc: 'Старт для вызовов с внутренних телефонов наружу',
      inputs: 0,
      outputs: [{ id: 'out', label: '▶ старт' }],
      fields: [
        { key: 'pattern', label: 'Шаблон набора', type: 'text', default: '_X.', help: 'По какому шаблону внутренний абонент выходит на этот маршрут: _X. — всё; _89XXXXXXXXX — мобильные РФ' },
      ],
      summary: d => ['шаблон: ' + (d.pattern || '_X.')],
    },

    /* ══ ДЕЙСТВИЯ ══ */
    answer: {
      title: 'Ответить', icon: '✅', cat: 'actions', color: '#38bdf8', desc: 'Answer() — поднять трубку АТС',
      inputs: 1, outputs: [{ id: 'out', label: 'далее' }],
      fields: [{ key: 'delay', label: 'Задержка перед ответом, сек', type: 'number', default: 0 }],
      summary: d => (Number(d.delay) > 0 ? ['пауза ' + d.delay + ' c'] : []),
    },
    playback: {
      title: 'Воспроизвести', icon: '🔊', cat: 'actions', color: '#38bdf8', desc: 'Проиграть аудиофайл Asterisk',
      inputs: 1, outputs: [{ id: 'out', label: 'далее' }],
      fields: [
        { key: 'greeting', label: 'Аудиофайл (без расширения)', type: 'select', options: GREETINGS, editable: true, default: 'hello', help: 'Файл из /var/lib/asterisk/sounds/ru или свой' },
        { key: 'interruptible', label: 'Можно прервать клавишей', type: 'checkbox', default: false, help: 'Background() вместо Playback()' },
      ],
      summary: d => ['♪ ' + (d.greeting || 'hello')],
    },
    ivr: {
      title: 'IVR-меню', icon: '🎛', cat: 'actions', color: '#a78bfa',
      desc: 'Голосовое меню с выбором цифрами',
      inputs: 1,
      outputsFn: d => (Array.isArray(d.keys) ? d.keys : []).map(k => ({ id: 'k' + k, label: 'кл. ' + k }))
        .concat((d.useT !== false) ? [{ id: 'kt', label: '⏱ таймаут' }] : [])
        .concat((d.useI) ? [{ id: 'ki', label: '⁉ ошибка' }] : []),
      fields: [
        { key: 'greeting', label: 'Приветствие меню', type: 'select', options: GREETINGS, editable: true, default: 'demo-congrats' },
        { key: 'timeout', label: 'Таймаут ввода, сек', type: 'number', default: 10 },
        { key: 'keys', label: 'Клавиши меню', type: 'keys', default: ['1', '2', '0'], help: 'По одной в строке: 0–9, *, #. Каждая клавиша = отдельный выход блока' },
        { key: 'useT', label: 'Выход «таймаут» (t)', type: 'checkbox', default: true },
        { key: 'useI', label: 'Выход «неверный ввод» (i)', type: 'checkbox', default: false },
      ],
      summary: d => ['клавиши: ' + (Array.isArray(d.keys) ? d.keys.join(', ') : '')],
    },
    record: {
      title: 'Запись разговора', icon: '⏺', cat: 'actions', color: '#38bdf8', desc: 'MixMonitor — вкл/выкл записи',
      inputs: 1, outputs: [{ id: 'out', label: 'далее' }],
      fields: [
        { key: 'mode', label: 'Режим', type: 'select', options: [['start', 'Начать запись'], ['stop', 'Остановить запись']], default: 'start' },
        { key: 'name', label: 'Метка файла', type: 'text', default: 'call' },
        { key: 'append', label: 'Дописывать в существующий', type: 'checkbox', default: false },
      ],
      summary: d => [d.mode === 'stop' ? '⏹ стоп' : '⏺ старт: ' + (d.name || 'call')],
    },
    wait: {
      title: 'Пауза', icon: '⏳', cat: 'actions', color: '#38bdf8', desc: 'Wait(n секунд)',
      inputs: 1, outputs: [{ id: 'out', label: 'далее' }],
      fields: [{ key: 'seconds', label: 'Секунд', type: 'number', default: 2 }],
      summary: d => ['⏳ ' + (d.seconds || 1) + ' c'],
    },
    setcallerid: {
      title: 'Изменить CallerID', icon: '🪪', cat: 'actions', color: '#38bdf8', desc: 'Подмена отображаемого номера',
      inputs: 1, outputs: [{ id: 'out', label: 'далее' }],
      fields: [
        { key: 'number', label: 'Номер', type: 'text', default: '', help: 'Оставьте пустым — сохранится текущий' },
        { key: 'name', label: 'Имя', type: 'text', default: '' },
      ],
      summary: d => (d.number ? ['CID: ' + d.number] : []),
    },
    setvar: {
      title: 'Переменная', icon: '🧮', cat: 'actions', color: '#38bdf8', desc: 'Set(VAR=значение)',
      inputs: 1, outputs: [{ id: 'out', label: 'далее' }],
      fields: [
        { key: 'name', label: 'Имя переменной', type: 'text', default: 'MYVAR' },
        { key: 'value', label: 'Значение / выражение', type: 'text', default: '' },
      ],
      summary: d => [d.name + ' = ' + (d.value || '…')],
    },
    curl: {
      title: 'HTTP-запрос', icon: '🌐', cat: 'actions', color: '#38bdf8', desc: 'CURL() — интеграция с CRM/API',
      inputs: 1, outputs: [{ id: 'out', label: 'далее' }],
      fields: [{ key: 'url', label: 'URL', type: 'text', default: 'http://', help: 'Результат попадает в переменную CURLRES' }],
      summary: d => [String(d.url || '').slice(0, 26)],
    },
    log: {
      title: 'Лог / метка', icon: '📋', cat: 'actions', color: '#38bdf8', desc: 'Запись в лог Asterisk',
      inputs: 1, outputs: [{ id: 'out', label: 'далее' }],
      fields: [{ key: 'text', label: 'Текст', type: 'text', default: 'marker' }],
      summary: d => ['📋 ' + String(d.text || '').slice(0, 22)],
    },

    /* ══ ЛОГИКА ══ */
    time: {
      title: 'Условие времени', icon: '🕒', cat: 'logic', color: '#f472b6',
      desc: 'Ветвление по расписанию (рабочие часы)',
      inputs: 1,
      outputs: [{ id: 'match', label: '✔ входит' }, { id: 'nomatch', label: '✘ не входит' }],
      fields: [
        { key: 'start', label: 'Начало (ЧЧ:ММ)', type: 'text', default: '09:00' },
        { key: 'end', label: 'Конец (ЧЧ:ММ)', type: 'text', default: '18:00' },
        { key: 'days', label: 'Дни недели', type: 'select', options: DOW, default: 'mon-fri' },
      ],
      summary: d => [`${d.start || '09:00'}–${d.end || '18:00'}`, (DOW.find(x => x[0] === d.days) || [])[1] || (d.days || '')],
    },
    condition: {
      title: 'Условие', icon: '🔀', cat: 'logic', color: '#f472b6',
      desc: 'Произвольное выражение Asterisk',
      inputs: 1,
      outputs: [{ id: 'yes', label: '✔ да' }, { id: 'no', label: '✘ нет' }],
      fields: [{ key: 'expr', label: 'Выражение', type: 'textarea', default: '"${CALLERID(num)}" = "79123456789"', help: 'Внутри GotoIf($[…]): переменные, сравнения, функции' }],
      summary: d => [String(d.expr || '').slice(0, 30)],
    },

    /* ══ УСТРОЙСТВА / НАЗНАЧЕНИЯ ══ */
    dial: {
      title: 'Вызов абонента', icon: '☎', cat: 'targets', color: '#4ade80',
      desc: 'Позвонить SIP-устройству из реестра',
      inputs: 1, outputs: [{ id: 'out', label: 'после / неотв.' }],
      fields: [
        { key: 'device', label: 'Абонент', type: 'devref', default: '' },
        { key: 'timeout', label: 'Таймаут, сек', type: 'number', default: 30 },
        { key: 'options', label: 'Опции Dial', type: 'text', default: 'tT' },
      ],
      summary: d => ['→ ' + (d.device || 'не задан') + (d.timeout ? ', ' + d.timeout + ' c' : '')],
    },
    ringgroup: {
      title: 'Группа вызова', icon: '📱', cat: 'targets', color: '#4ade80',
      desc: 'Несколько абонентов: все сразу или по очереди',
      inputs: 1, outputs: [{ id: 'out', label: 'после / неотв.' }],
      fields: [
        { key: 'mode', label: 'Режим', type: 'select', options: [['par', 'Все одновременно'], ['seq', 'По очереди']], default: 'par' },
        { key: 'timeout', label: 'Таймаут на шаг, сек', type: 'number', default: 25 },
        { key: 'members', label: 'Участники', type: 'members', default: [] },
      ],
      summary: d => {
        const m = (Array.isArray(d.members) ? d.members : []);
        return [m.length ? (d.mode === 'seq' ? m.join(' → ') : m.join(' + ')) : 'участники не выбраны'];
      },
    },
    queue: {
      title: 'Очередь', icon: '👥', cat: 'targets', color: '#4ade80',
      desc: 'Очередь операторов (call-центр)',
      inputs: 1, outputs: [{ id: 'out', label: 'после / неотв.' }],
      fields: [
        { key: 'name', label: 'Имя очереди', type: 'text', default: 'support', help: 'Очередь будет создана в queues.conf автоматически' },
        { key: 'timeout', label: 'Таймаут ожидания, сек', type: 'number', default: 300 },
        { key: 'options', label: 'Опции Queue', type: 'text', default: 't' },
      ],
      summary: d => ['очередь: ' + (d.name || '?')],
    },
    conference: {
      title: 'Конференция', icon: '🏢', cat: 'targets', color: '#4ade80',
      desc: 'ConfBridge — комната совещаний',
      inputs: 1, outputs: [{ id: 'out', label: 'после выхода' }],
      fields: [
        { key: 'room', label: 'Номер комнаты', type: 'text', default: '900' },
        { key: 'pin', label: 'PIN (необязательно)', type: 'text', default: '' },
      ],
      summary: d => ['комната ' + (d.room || '?') + (d.pin ? ' 🔒' : '')],
    },
    voicemail: {
      title: 'Голосовая почта', icon: '📬', cat: 'targets', color: '#4ade80',
      desc: 'VoiceMail — записать сообщение',
      inputs: 1, outputs: [{ id: 'out', label: 'после записи' }],
      fields: [
        { key: 'box', label: 'Ящик (номер)', type: 'text', default: '100' },
        { key: 'context', label: 'Контекст', type: 'text', default: 'default' },
        { key: 'mode', label: 'Приветствие', type: 'select', options: [['u', '«Абонент недоступен» (u)'], ['b', '«Занято» (b)'], ['s', 'Без приветствия (s)']], default: 'u' },
        { key: 'exit', label: 'Продолжить после записи', type: 'checkbox', default: false, help: 'Иначе вызов завершится' },
      ],
      summary: d => ['ящик ' + (d.box || '?') + ' (' + (d.mode || 'u') + ')'],
    },
    forward: {
      title: 'Переадресация', icon: '↗', cat: 'targets', color: '#fb923c',
      desc: 'Перевод на внешний номер через транк',
      inputs: 1, outputs: [{ id: 'out', label: 'по неответу' }],
      fields: [
        { key: 'number', label: 'Номер направления', type: 'text', default: '', help: 'Например +79990001122. Укажите $DIALED — подставить набранный номер' },
        { key: 'trunk', label: 'Через транк', type: 'trunkref', default: '' },
        { key: 'timeout', label: 'Таймаут, сек', type: 'number', default: 30 },
      ],
      summary: d => ['↗ ' + (d.number || '?') + ' @ ' + (d.trunk || '?')],
    },
    outtrunk: {
      title: 'Внешний номер (транк)', icon: '🌐', cat: 'targets', color: '#fb923c',
      desc: 'Отправить вызов в транк (конец исходящего маршрута)',
      inputs: 1, outputs: [{ id: 'out', label: 'по неответу' }],
      fields: [
        { key: 'trunk', label: 'Транк', type: 'trunkref', default: '' },
        { key: 'useDialed', label: 'Набирать номер, введённый абонентом', type: 'checkbox', default: true },
        { key: 'number', label: 'Фиксированный номер', type: 'text', default: '', help: 'Если выключен флаг выше' },
        { key: 'timeout', label: 'Таймаут, сек', type: 'number', default: 60 },
      ],
      summary: d => [d.useDialed !== false ? 'набранный номер' : ('→ ' + d.number), '@ ' + (d.trunk || '?')],
    },
    park: {
      title: 'Парковка', icon: '🅿', cat: 'targets', color: '#fb923c', desc: 'Park() — припарковать вызов',
      inputs: 1, outputs: [],
      fields: [],
      summary: () => [],
    },
    busy: {
      title: 'Сигнал «занято»', icon: '🚫', cat: 'targets', color: '#ef4444', desc: 'Busy() и завершение',
      inputs: 1, outputs: [],
      fields: [{ key: 'seconds', label: 'Секунд сигнала', type: 'number', default: 5 }],
      summary: () => ['⛔ busy'],
    },
    hangup: {
      title: 'Завершить вызов', icon: '📵', cat: 'targets', color: '#ef4444', desc: 'Hangup() — конец сценария',
      inputs: 1, outputs: [],
      fields: [{ key: 'cause', label: 'Код причины (необяз.)', type: 'text', default: '', help: 'Например 16 — нормальное завершение' }],
      summary: d => (d.cause ? ['код ' + d.cause] : []),
    },
  };

  const CATEGORIES = [
    { id: 'entry', title: 'Точки входа' },
    { id: 'actions', title: 'Действия' },
    { id: 'logic', title: 'Логика' },
    { id: 'targets', title: 'Устройства и назначения' },
  ];

  function outputsOf(node) {
    const def = DEFS[node.type];
    if (!def) return [];
    if (typeof def.outputsFn === 'function') return def.outputsFn(node.data || {});
    return def.outputs || [];
  }
  function inputsOf(node) {
    const def = DEFS[node.type];
    return def && def.inputs ? [{ id: 'in', label: '' }] : [];
  }
  function defaultData(type) {
    const def = DEFS[type];
    const d = {};
    (def.fields || []).forEach(f => { d[f.key] = Array.isArray(f.default) ? f.default.slice() : f.default; });
    return d;
  }

  window.BLOCK_DEFS = DEFS;
  window.BLOCK_CATEGORIES = CATEGORIES;
  window.outputsOf = outputsOf;
  window.inputsOf = inputsOf;
  window.defaultData = defaultData;
})();
