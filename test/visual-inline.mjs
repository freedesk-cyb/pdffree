/* ============================================================
   visual-inline.mjs — Captura del editor en línea funcionando:
   caja seleccionada + editor abierto encima del texto, con la
   tipografía real del documento.

   Salida: test/out/shots/inline-editor.png
   ============================================================ */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8134, CDP = 9344, ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shots = resolve(here, 'out/shots');
await mkdir(shots, { recursive: true });

const profile = resolve(here, 'out/chrome-vis');
await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
await mkdir(profile, { recursive: true });
const server = spawn(process.execPath, [resolve(root, 'serve.mjs'), String(PORT)], { cwd: root, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1500,1050', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} });
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(250); }

const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(ORIGIN + '/')}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { pend.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return r.result.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: ORIGIN + '/' });
await sleep(2500);

const info = await ev(`
  const src = new Uint8Array(await (await fetch('/test/fixtures/subconjunto.pdf')).arrayBuffer());
  await window.PDFFree.open(new File([src], 'curriculum.pdf', { type: 'application/pdf' }));
  await new Promise(r => setTimeout(r, 1200));
  const chk = document.querySelector('#showTextBoxes');
  if (!chk.checked) chk.click();
  await new Promise(r => setTimeout(r, 3000));

  /* clic sobre la línea de experiencia */
  const caja = [...document.querySelectorAll('#pages-edit .tbox')]
    .find(c => /Ingenieria/.test(c.title));
  caja.click();
  await new Promise(r => setTimeout(r, 700));

  /* el usuario escribe encima */
  const ta = document.querySelector('.item[data-editing="1"] textarea');
  ta.value = 'Ingenieria de sistemas e informatica, con intereses en desarrollo.';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  return {
    fuente: getComputedStyle(ta).fontFamily,
    cajas: document.querySelectorAll('#pages-edit .tbox').length,
    item: window.PDFFree.S.editItems[1].find(i => i.inplace)?.text,
  };
`);

const r = await send('Page.captureScreenshot', { format: 'png' });
await writeFile(resolve(shots, 'inline-editor.png'), Buffer.from(r.data, 'base64'));

console.log('   cajas detectadas:', info.cajas);
console.log('   fuente en el editor:', info.fuente);
console.log('   texto en el elemento:', info.item);
console.log('   captura: test/out/shots/inline-editor.png');
process.exit(0);