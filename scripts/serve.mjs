/**
 * Serves dist/ with exactly the headers in vercel.json, so the browser tests can run under the
 * same Content-Security-Policy the hosted page uses: `node scripts/serve.mjs [port]`.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const port = Number(process.argv[2] ?? 4300);
const config = JSON.parse(readFileSync('vercel.json', 'utf8'));
const headers = Object.fromEntries(config.headers.flatMap((rule) => rule.headers.map((h) => [h.key, h.value])));
const page = readFileSync(join('dist', 'index.html'));

createServer((request, response) => {
  if (request.url === '/' || request.url === '/index.html') {
    response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page);
    return;
  }
  response.writeHead(404, headers);
  response.end('Not found');
}).listen(port, () => console.log(`Serving dist/ with vercel.json headers on http://localhost:${port}/`));
