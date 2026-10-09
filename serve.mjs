#!/usr/bin/env node
/* ============================================================
   serve.mjs — Servidor estático mínimo, cero dependencias.
   Sirve la web en local para probarla o usarla sin internet.
   Uso:  node serve.mjs [puerto]
   ============================================================ */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { networkInterfaces } from 'node:os';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.bcmap': 'application/octet-stream',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.pfb': 'application/octet-stream',
};

/* El código propio se sirve sin caché (si no, el navegador se queda
   con una versión vieja y parece que los cambios no aplican). Las librerías
   de /vendor no cambian y se cachean para siempre. */
function esVendor(full) {
  return full.includes('/vendor/') || full.includes('\\vendor\\');
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';

    // impedir salir del directorio del proyecto
    const full = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(ROOT)) {
      res.writeHead(403).end('403');
      return;
    }

    const info = await stat(full).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('404 — no encontrado: ' + path);
      return;
    }

    const body = await readFile(full);
    const headers = {
      'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': esVendor(full) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    // Cabeceras de aislamiento: necesarias para SharedArrayBuffer y para
    // que algunos navegadores Threads acepten WebAssembly. Se pueden
    // desactivar con NO_COEP=1 si rompen algún recurso.
    if (process.env.NO_COEP !== '1') {
      headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      headers['Cross-Origin-Embedder-Policy'] = 'credentialless';
      headers['Cross-Origin-Resource-Policy'] = 'same-origin';
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 ' + e.message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  PDF Free — servidor local\n');
  console.log(`  →  http://localhost:${PORT}`);
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  →  http://${a.address}:${PORT}   (${name}, desde la red local)`);
    }
  }
  console.log('\n  Ctrl+C para detener. Nada sale de tu equipo: el navegador hace todo.\n');
});