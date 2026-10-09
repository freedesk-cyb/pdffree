/* Captura del editor en línea sobre el PDF tipo curriculum, para verlo a ojo. */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8151, CDP = 9361, ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));

await mkdir(resolve(here, 'out/shots'), { recursive: true });
const profile = resolve(here, 'out/chrome-shot');
await rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
await mkdir(profile, { recursive: true });
const server = spawn(process.execPath, [resolve(root, 'serve.mjs'), String(PORT)], { cwd: root, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1400,1200', '--force-device-scale-factor=1',
  'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} });
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(250); }
const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(ORIGIN + '/')}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pend = new Map(); const errores = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { pend.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return r.result.value;
};
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errores.push(m.params.entry.text);
});
await send('Page.navigate', { url: ORIGIN + '/' });
await sleep(3000);

await ev(`
  const src = new Uint8Array(await (await fetch('/test/fixtures/cv.pdf')).arrayBuffer());
  await window.PDFFree.open(new File([src], 'cv.pdf', { type: 'application/pdf' }));
  await new Promise(r => setTimeout(r, 1000));
  const chk = document.querySelector('#showTextBoxes');
  if (!chk.checked) chk.click();
  await new Promise(r => setTimeout(r, 3500));
`);
const shot1 = await send('Page.captureScreenshot', { format: 'png' });
const { writeFileSync } = await import('node:fs');
writeFileSync(resolve(here, 'out/shots/cv-cajas.png'), Buffer.from(shot1.data, 'base64'));

/* se abre el editor sobre una línea concreta */
const info = await ev(`
  const caja = [...document.querySelectorAll('#pages-edit .tbox')].find(c => c.title === 'UNIVERSIDAD NORBERT WIENER');
  caja.click();
  await new Promise(r => setTimeout(r, 800));
  const ta = document.querySelector('.item[data-editing="1"] textarea');
  ta.value = 'UNIVERSIDAD TECNOLOGICA';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  const st = getComputedStyle(ta);
  return { fuente: st.fontFamily, tam: st.fontSize, valor: ta.value };
`);
const shot2 = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(resolve(here, 'out/shots/cv-editor.png'), Buffer.from(shot2.data, 'base64'));

/* se confirman dos cambios y se ve la página ya redibujada + la lista */
const vivo = await ev(`
  const editar = async (titulo, nuevo) => {
    const c = [...document.querySelectorAll('#pages-edit .tbox')].find(x => x.title === titulo);
    c.click();
    await new Promise(r => setTimeout(r, 600));
    const ta = document.querySelector('.item[data-editing="1"] textarea');
    ta.value = nuevo;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 1200));
  };
  await editar('UNIVERSIDAD LAS AMERICAS', 'UNIVERSIDAD LAS AMERICAS');
  await editar('Especialista de soporte Service Desk N2', 'Especialista senior de soporte N1');
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (!document.querySelector('#pages-edit .item[data-kind="text"]')) break;
  }
  await new Promise(r => setTimeout(r, 2500));
  return {
    cambios: document.querySelectorAll('#cambiosLista .cambio').length,
    info: document.querySelector('#cambiosInfo').textContent,
    enCapa: document.querySelectorAll('#pages-edit .item[data-kind="text"]').length,
  };
`);
const shot3 = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(resolve(here, 'out/shots/cv-vivo.png'), Buffer.from(shot3.data, 'base64'));

console.log('editor:', JSON.stringify(info));
console.log('vista en vivo:', JSON.stringify(vivo));
console.log('errores de consola:', errores.length ? errores : 'ninguno');
console.log('capturas: out/shots/cv-cajas.png · out/shots/cv-editor.png');
process.exit(0);