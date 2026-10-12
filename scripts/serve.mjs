#!/usr/bin/env node
/**
 * Локальный статический сервер для просмотра FlowPBX.
 *
 * Отдаёт `dist/`, если сборка уже выполнена, иначе корень репозитория.
 * Зависимостей нет — нужен только Node.js.
 *
 *   npm run serve            # http://localhost:8080
 *   PORT=3000 npm run serve  # свой порт
 *   npm run serve -- --src   # принудительно отдавать исходный index.html
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.gz': 'application/gzip',
  '.br': 'application/octet-stream',
};

/** Каталог, который отдаём: собранный dist/, иначе корень проекта. */
function pickBaseDir() {
  if (process.argv.includes('--src')) return ROOT;
  const dist = join(ROOT, 'dist');
  return existsSync(join(dist, 'index.html')) ? dist : ROOT;
}

const BASE = pickBaseDir();

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const filePath = resolve(join(BASE, normalize(pathname)));
  // Защита от выхода за пределы каталога.
  if (!filePath.startsWith(BASE)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 Not found');
    return;
  }

  const bytes = statSync(filePath).size;
  res.writeHead(200, {
    'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'content-length': bytes,
    'cache-control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`FlowPBX: ${BASE.replace(ROOT, '.')}`);
  console.log(`  → http://localhost:${PORT}/`);
});
