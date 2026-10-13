#!/usr/bin/env node
/**
 * FlowPBX — сборка статической страницы.
 *
 * Проект намеренно остаётся «одним файлом»: `index.html` без внешних зависимостей.
 * Поэтому сборка не транспилирует и не минифицирует код (это ломало бы читаемость
 * прототипа), а выполняет три задачи:
 *
 *   1. Проверяет целостность страницы (структура, самодостаточность, синтаксис
 *      встроенного JS и CSS, наличие id, к которым обращается bootstrap-код).
 *   2. Кладёт в `dist/` готовый к публикации `index.html` с метаданными сборки
 *      (версия, коммит, дата) и `manifest.json`.
 *   3. Готовит предварительно сжатые копии `.gz` / `.br` для статического хостинга
 *      и копирует содержимое `public/`, если оно появится.
 *
 * Использование:
 *   node scripts/build.mjs [--out dist] [--no-compress] [--quiet]
 *
 * Код возврата: 0 — успех, 1 — ошибка проверки или записи.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'index.html');
const PUBLIC_DIR = join(ROOT, 'public');

/** id, которые bootstrap-код страницы читает напрямую при старте. */
const CRITICAL_IDS = [
  'canvasViewport',
  'stageSize',
  'world',
  'edgesSvg',
  'nodesLayer',
  'canvasTitle',
  'canvasMeta',
  'canvasFooterCount',
  'saveState',
  'paletteList',
  'paletteSearch',
  'paletteCount',
  'inspectorBody',
  'inspectorMode',
  'modalRoot',
  'toastRoot',
  'codeBtn',
  'validateBtn',
  'testBtn',
  'publishBtn',
  'undoBtn',
  'redoBtn',
  'zoomInBtn',
  'zoomOutBtn',
  'zoomValue',
  'fitBtn',
];

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
};
const OUT_DIR = resolve(ROOT, getArg('out') ?? 'dist');
const COMPRESS = getArg('no-compress') === null;
const QUIET = getArg('quiet') !== null;

const log = (...parts) => {
  if (!QUIET) console.log(...parts);
};

const failures = [];
const warnings = [];
const fail = (message) => failures.push(message);
const warn = (message) => warnings.push(message);

/* ------------------------------------------------------------------ утилиты */

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} КБ`;

function gitInfo() {
  const run = (gitArgs) => {
    try {
      return execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  return {
    commit: run(['rev-parse', '--short', 'HEAD']) ?? 'unknown',
    branch: process.env.GITHUB_REF_NAME || run(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown',
    dirty: run(['status', '--porcelain']) ? true : false,
  };
}

/** Убирает из разметки содержимое <script> и <style>, чтобы не искать в коде HTML-атрибуты. */
const stripCodeBlocks = (html) =>
  html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '<$1></$1>');

/* ------------------------------------------------------------------- проверка */

function checkDocument(html) {
  if (!/^\s*<!doctype html>/i.test(html)) fail('нет объявления <!doctype html> в начале файла');
  if (!/<html[^>]*\blang=["'][a-z]{2,}["']/i.test(html)) fail('у <html> отсутствует атрибут lang');
  if (!/<meta[^>]+charset=["']?utf-8/i.test(html)) fail('нет <meta charset="utf-8">');
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) fail('нет <meta name="viewport">');

  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  if (!title) fail('пустой или отсутствующий <title>');

  const markup = stripCodeBlocks(html);

  // Страница обязана оставаться самодостаточной: ни внешних, ни корневых абсолютных
  // ссылок на ресурсы — иначе она сломается при открытии с файловой системы
  // или при публикации в подкаталог GitHub Pages.
  const assetTag = /<(script|link|img|iframe|source|video|audio)\b([^>]*)>/gi;
  let external = 0;
  for (const [, tag, attrs] of markup.matchAll(assetTag)) {
    const ref = attrs.match(/\b(?:src|href)=["']([^"']+)["']/i)?.[1];
    if (!ref || ref.startsWith('data:')) continue;
    if (/^(https?:)?\/\//i.test(ref)) {
      fail(`<${tag}> ссылается на внешний ресурс: ${ref}`);
      external += 1;
    } else if (ref.startsWith('/')) {
      fail(`<${tag}> использует абсолютный путь ${ref} — страница должна работать из любого подкаталога`);
      external += 1;
    } else if (!existsSync(join(ROOT, ref))) {
      fail(`<${tag}> ссылается на отсутствующий файл: ${ref}`);
      external += 1;
    }
  }

  for (const [, url] of markup.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    if (/^(https?:)?\/\//i.test(url) || url.startsWith('/')) {
      fail(`в CSS встречается внешняя или абсолютная ссылка url(${url})`);
      external += 1;
    } else if (!url.startsWith('data:') && !existsSync(join(ROOT, url))) {
      fail(`в CSS ссылка url(${url}) ведёт на отсутствующий файл`);
      external += 1;
    }
  }

  const ids = [...markup.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]);
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) fail(`дублирующийся id в разметке: ${id}`);
    seen.add(id);
  }
  const missing = CRITICAL_IDS.filter((id) => !seen.has(id));
  if (missing.length) fail(`в разметке нет обязательных id: ${missing.join(', ')}`);

  const links = [...markup.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)].map((m) => m[1]);
  log(`  разметка: ${ids.length} id, ${links.length} ссылок <a>, внешних ресурсов: ${external}`);
}

function checkScripts(html) {
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  let inline = 0;
  blocks.forEach(([, attrs, code], index) => {
    if (/\bsrc=/i.test(attrs)) return;
    inline += 1;
    if (!code.trim()) {
      warn(`встроенный <script> №${index + 1} пуст`);
      return;
    }
    try {
      // Компиляция без выполнения: ловит синтаксические ошибки.
      new Script(code, { filename: `inline-script-${index + 1}.js` });
    } catch (error) {
      fail(`синтаксическая ошибка во встроенном JS (блок №${index + 1}): ${error.message}`);
      return;
    }
    const logs = (code.match(/\bconsole\.(log|debug)\s*\(/g) || []).length;
    const debuggers = (code.match(/^\s*debugger\b/gm) || []).length;
    if (debuggers) fail(`во встроенном JS осталось ${debuggers} оператор(ов) debugger`);
    if (logs) warn(`во встроенном JS ${logs} вызов(ов) console.log/debug`);
    if (!/'use strict'|^import |^export /m.test(code)) warn('встроенный JS не в строгом режиме');
  });
  log(`  JS: блоков <script> — ${blocks.length}, проверено встроенных — ${inline}`);
  return inline;
}

function checkStyles(html) {
  const blocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
  let selectors = 0;
  blocks.forEach(([, css], index) => {
    // Комментарии и строки убираем, чтобы скобки внутри них не ломали подсчёт.
    const clean = css
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''");
    for (const [open, close, name] of [['{', '}', 'фигурные скобки'], ['(', ')', 'круглые скобки'], ['[', ']', 'квадратные скобки']]) {
      const diff = [...clean].filter((c) => c === open).length - [...clean].filter((c) => c === close).length;
      if (diff !== 0) fail(`CSS блок №${index + 1}: не сбалансированы ${name} (разница ${diff})`);
    }
    selectors += (clean.match(/\{/g) || []).length;
  });
  log(`  CSS: блоков <style> — ${blocks.length}, правил ≈ ${selectors}`);
}

/* --------------------------------------------------------------------- сборка */

function injectBuildMeta(html, meta) {
  const tag = `  <meta name="flowpbx-build" content="${meta.content}">`;
  if (html.includes('name="flowpbx-build"')) {
    return html.replace(/[ ]*<meta[^>]*name="flowpbx-build"[^>]*>/, tag);
  }
  if (!/<\/head>/i.test(html)) {
    fail('не найден </head> — некуда вставить метаданные сборки');
    return html;
  }
  return html.replace(/<\/head>/i, `${tag}\n</head>`);
}

function writeOutputs(html, meta) {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const write = (name, data) => {
    const path = join(OUT_DIR, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
  };

  write('index.html', html);

  if (existsSync(PUBLIC_DIR) && statSync(PUBLIC_DIR).isDirectory()) {
    cpSync(PUBLIC_DIR, OUT_DIR, { recursive: true });
    log('  public/: скопировано в dist/');
  }

  if (COMPRESS) {
    const raw = Buffer.from(html, 'utf8');
    write('index.html.gz', gzipSync(raw, { level: 9 }));
    write('index.html.br', brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }));
  }

  // Собираем манифест по фактическому содержимому dist/ (без самого манифеста).
  const files = readdirSync(OUT_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .map((path) => relative(OUT_DIR, path).split(/[\\/]/).join('/'))
    .sort()
    .map((name) => {
      const data = readFileSync(join(OUT_DIR, name));
      return { path: name, bytes: data.byteLength, sha256: sha256(data) };
    });

  const manifest = {
    name: 'flowpbx',
    version: meta.version,
    commit: meta.commit,
    branch: meta.branch,
    builtAt: meta.builtAt,
    generator: 'scripts/build.mjs',
    entry: 'index.html',
    files,
  };
  write('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/* ----------------------------------------------------------------------- main */

function main() {
  const started = Date.now();
  log('FlowPBX: сборка');

  if (!existsSync(SOURCE)) {
    console.error(`✖ Не найден исходный файл ${relative(ROOT, SOURCE)}`);
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const git = gitInfo();
  const source = readFileSync(SOURCE, 'utf8');

  checkDocument(source);
  checkScripts(source);
  checkStyles(source);

  const meta = {
    version: pkg.version,
    commit: git.commit,
    branch: git.branch,
    builtAt: new Date().toISOString(),
  };
  meta.content = `v${meta.version} · ${meta.commit}${git.dirty ? '-dirty' : ''} · ${meta.builtAt}`;

  const output = injectBuildMeta(source, meta);
  const manifest = writeOutputs(output, meta);

  if (warnings.length) {
    log('');
    warnings.forEach((message) => log(`⚠ ${message}`));
  }

  if (failures.length) {
    console.error('');
    failures.forEach((message) => console.error(`✖ ${message}`));
    console.error(`\nСборка прервана: ошибок ${failures.length}.`);
    process.exit(1);
  }

  const html = manifest.files.find((f) => f.path === 'index.html');
  log('');
  log(`✔ Собрано за ${Date.now() - started} мс`);
  log(`  версия: v${meta.version} · коммит ${meta.commit} (${meta.branch})`);
  log(`  ${relative(ROOT, OUT_DIR)}/index.html — ${kb(html.bytes)} · sha256 ${html.sha256.slice(0, 12)}…`);
  for (const file of manifest.files) {
    if (file.path === 'index.html') continue;
    log(`  ${relative(ROOT, OUT_DIR)}/${file.path} — ${kb(file.bytes)}`);
  }
}

main();
