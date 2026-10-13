'use strict';
/** Минимальный AMI-клиент (Asterisk Manager Interface) без зависимостей. */
const net = require('net');

/**
 * Выполнить последовательность AMI-действий: Login → actions → Logoff.
 * @returns Promise<{banner:string, responses:string[]}>
 */
function run({ host = '127.0.0.1', port = 5038, user = '', secret = '', actions = [], timeout = 6000 }) {
  return new Promise((resolve, reject) => {
    const responses = [];
    let banner = '';
    let stage = 'hello';
    let sent = 0;
    let buf = '';
    let settled = false;

    const sock = new net.Socket();
    const fail = err => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(err);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      try { send({ Action: 'Logoff' }); } catch (_) { /* noop */ }
      setTimeout(() => sock.destroy(), 150);
      resolve({ banner, responses });
    };
    const send = obj => {
      sock.write(Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
    };

    const timer = setTimeout(() => fail(new Error('AMI: таймаут соединения/ответа')), timeout);
    const clear = () => clearTimeout(timer);

    sock.on('error', err => { clear(); fail(new Error('AMI: ' + err.message)); });
    sock.on('connect', () => { /* ждём баннер */ });
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n\r\n')) >= 0 || (stage === 'hello' && buf.indexOf('\r\n') > 0)) {
        let msg;
        if (stage === 'hello') {
          const eol = buf.indexOf('\r\n');
          msg = buf.slice(0, eol);
          buf = buf.slice(eol + 2);
          banner = msg.replace(/^Asterisk Call Manager\//, '').trim();
          stage = 'login';
          send({ Action: 'Login', Username: user, Secret: secret });
          continue;
        }
        msg = buf.slice(0, idx);
        buf = buf.slice(idx + 4);

        if (stage === 'login') {
          if (/Authentication accepted/.test(msg)) {
            if (actions.length === 0) { clear(); done(); return; }
            stage = 'run';
            actions.forEach((a, i) => send({ ActionID: 'aid' + i, ...a }));
            sent = actions.length;
          } else {
            clear(); fail(new Error('AMI: аутентификация отклонена')); return;
          }
        } else if (stage === 'run') {
          if (/^Response:/.test(msg)) responses.push(msg);
          if (responses.length >= sent) { clear(); done(); return; }
        }
      }
    });
  });
}

const testConnection = opts => run({ ...opts, actions: [] });
const reloadDialplan = opts => run({ ...opts, actions: [{ Action: 'Command', Command: 'dialplan reload' }, { Action: 'Command', Command: 'module reload res_pjsip.so' }] });

module.exports = { run, testConnection, reloadDialplan };
