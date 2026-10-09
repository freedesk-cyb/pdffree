/* ============================================================
   visual-inplace.mjs — Prueba visual del motor de edición en sitio.
   Genera un PDF con una fuente incrustada condensada (Arial Narrow),
   edita una línea pulsando sobre ella como en la interfaz y renderiza
   el ANTES y el DESPUÉS para poder compararlos.

   Salida: test/out/shots/inplace-antes.png y inplace-despues.png
   ============================================================ */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8130, CDP = 9340, ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shots = resolve(here, 'out/shots');
await mkdir(shots, { recursive: true });

const profile = resolve(here, 'out/chrome-vi');
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

/* --- el navegador crea un PDF con Arial Narrow incrustada --- */
console.log('\n1. Creando PDF con Arial Narrow (fuente condensada incrustada)…');
const r64 = await ev(`
  const bytes = new Uint8Array(await (await fetch('/test/fixtures/arialn.ttf')).arrayBuffer());
  const doc = await PDFLib.PDFDocument.create();
  doc.registerFontkit(window.fontkit);
  const font = await doc.embedFont(bytes, { subset: true });
  const p = doc.addPage([760, 300]);
  p.drawText('Ingenieria de Sistemas e informatica, con intereses en desarrollo, soporte TI, redes y seguridad.', { x: 40, y: 240, size: 15, font });
  p.drawText('Formacion y soporte en proyectos innovadores dentro de la industria tecnologica.', { x: 40, y: 195, size: 15, font });
  p.drawText('Educacion', { x: 40, y: 130, size: 19, font });
  const bytes2 = await doc.save();

  await window.PDFFree.open(new File([bytes2], 'curriculum.pdf', { type: 'application/pdf' }));
  await new Promise(r => setTimeout(r, 1500));

  document.querySelector('#showTextBoxes').click();
  await new Promise(r => setTimeout(r, 1800));
  window.prompt = () => 'Ingenieria de Sistemas e informatica, con intereses en DESARROLLO, soporte TI, redes.';
  const cajas = [...document.querySelectorAll('#pages-edit .tbox')];
  const linea = cajas.find(c => /Ingenieria/i.test(c.title));
  linea.click();
  await new Promise(r => setTimeout(r, 600));

  const out = await window.PDFFree.build();
  const item = window.PDFFree.S.editItems[1].find(i => i.inplace);

  const render = async (src) => {
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    const doc2 = await pdfjs.getDocument({ data: src.slice(0) }).promise;
    const pg = await doc2.getPage(1);
    const vp = pg.getViewport({ scale: 2 });
    const cv = document.createElement('canvas');
    cv.width = vp.width; cv.height = vp.height;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: g, viewport: vp }).promise;
    return cv.toDataURL('image/png').split(',')[1];
  };

  return {
    antes: await render(bytes2),
    despues: await render(out),
    modo: item?._mode, fuente: item?._fontUsed, motivo: item?._inplaceError,
    cajas: cajas.length,
  };
`);

await writeFile(resolve(shots, 'inplace-antes.png'), Buffer.from(r64.antes, 'base64'));
await writeFile(resolve(shots, 'inplace-despues.png'), Buffer.from(r64.despues, 'base64'));
console.log('   cajas detectadas:', r64.cajas);
console.log('   método usado    :', r64.modo, r64.motivo ? '(' + r64.motivo + ')' : '');
console.log('   fuente usada    :', r64.fuente);
console.log('\n  capturas: inplace-antes.png · inplace-despues.png');
process.exit(0);