#!/usr/bin/env node
/**
 * プロトタイプを開くためのローカル静的サーバー。
 *
 * ## なぜサーバーが要るのか
 *
 * Phase 6a で、UI と再生エンジンの境界（Adapter）を `src/js/newui/adapter/` に置き、
 * プロトタイプがそれを `import` するようにした。実機の新UIは
 * `import(chrome.runtime.getURL(...))` で読み込む ES モジュールなので、
 * **プロトタイプと実機で同じコードを共有するには ES モジュールにするしかない。**
 *
 * ES モジュールは `file://` では読めない（origin が null になり CORS で弾かれる）。
 * そのため「index.html をダブルクリックで開く」はできなくなった。
 * 代わりにこの数十行のサーバーを噛ませる。**依存は無い。Node だけで動く。**
 *
 *   node prototype/now-playing/serve.cjs
 *   → http://localhost:8080/prototype/now-playing/
 *
 * ポートは第1引数か PORT 環境変数で変えられる。
 * リポジトリのルートを公開するのは、prototype から `../../src/` を読むため。
 * **ループバックにしか bind しない。** 外から見えるサーバーではない。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const ENTRY = '/prototype/now-playing/';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  // ES モジュールとして読ませるには正しい MIME が要る。text/plain だと拒否される。
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  // ルートの外へ出る経路を塞ぐ。ローカル専用でも、リポジトリの外は出さない。
  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`not found: ${pathname}\n`);
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      // 編集した内容がそのまま出るようにする。開発用なのでキャッシュしない。
      'cache-control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`prototype: http://localhost:${PORT}${ENTRY}`);
  console.log('  ?capture=1 で時計と背景を固定 / ?tune=1 で調整パネル / ?state=... で状態指定');
  console.log('  Ctrl+C で停止');
});
