/* Captura imitando el caso del usuario: la misma línea corregida varias
   veces y dos líneas parecidas. Debe verse una sola vez, sin duplicados. */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8185, CDP = 9395, ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));

await mkdir(resolve(here, 'out/shots'), { recursive: true });
const profile = resolve(here, 'out/chrome-shot2');
await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
await mkdir(profile, { recursive: true });
const server = spawn(process.execPath, [resolve(root, 'serve.mjs'), String(PORT)], { cwd: root, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1200,760', '--force-device-scale-factor=1',
  'about:blank'], { stdio: 'ignore' });
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
await send('Page.enable');
await send('Page.navigate', { url: ORIGIN + '/' });
await sleep(3000);

const info = await ev(`
  const src = new Uint8Array(await (await fetch('/test/fixtures/cv.pdf')).arrayBuffer());
  await window.PDFFree.open(new File([src], 'cv.pdf', { type: 'application/pdf' }));
  await new Promise(r => setTimeout(r, 1200));
  const chk = document.querySelector('#showTextBoxes');
  if (!chk.checked) chk.click();
  await new Promise(r => setTimeout(r, 3500));

  const editar = async (titulo, nuevo) => {
    const c = [...document.querySelectorAll('#pages-edit .tbox')].find(x => x.title === titulo);
    if (!c) return 'no hay caja: ' + titulo;
    c.click();
    await new Promise(r => setTimeout(r, 700));
    const ta = document.querySelector('.item[data-editing="1"] textarea');
    ta.value = nuevo;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 1400));
  };

  /* la misma línea, tres veces seguidas, como en el pantallazo */
  await editar('MAMANI MANDAMIENTO EDWIN OMAR', 'MAMANI MANDAMIENTO EDWIN OM');
  await editar('MAMANI MANDAMIENTO EDWIN OMAR', 'MAMANI MANDAMIENTO EDWIN');
  await editar('www.linkedin.com/in/edwin-omar-m-m/', 'linkedin.com/in/edwin-omar-m');
  await editar('UNIVERSIDAD NORBERT WIENER', 'UNIVERSIDAD TECNOLOXICA');
  await editar('UNIVERSIDAD NORBERT WIENER', 'UNIVERSIDAD NACIONAL');

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (window.PDFFree.S.previewBytes) break;
  }
  await new Promise(r => setTimeout(r, 3000));
  /* se ocultan las cajas para ver el documento tal cual quedará */
  document.querySelector('#showTextBoxes').click();
  await new Promise(r => setTimeout(r, 1200));
  return { cambios: document.querySelectorAll('#cambiosLista .cambio').length };
`);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(resolve(here, 'out/shots/cv-sin-duplicados.png'), Buffer.from(shot.data, 'base64'));
console.log('correcciones:', info.cambios);
console.log('captura: test/out/shots/cv-sin-duplicados.png');
process.exit(0);