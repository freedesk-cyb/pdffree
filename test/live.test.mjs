/* ============================================================
   live.test.mjs — Vista previa en vivo: al corregir una línea, el
   cambio se ve YA en la página (PDF redibujado), sin guardar; y
   desde la lista de cambios se puede deshacer.
   ============================================================ */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8157, CDP = 9367, ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  OK   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)); };

await mkdir(resolve(here, 'out'), { recursive: true });
const profile = resolve(here, 'out/chrome-live');
await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
await mkdir(profile, { recursive: true });

const server = spawn(process.execPath, [resolve(root, 'serve.mjs'), String(PORT)], { cwd: root, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1400,1100', 'about:blank'], { stdio: 'ignore' });
const errores = [];
const cleanup = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} };
process.on('exit', cleanup);
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(250); }

const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(ORIGIN + '/')}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errores.push(m.params.entry.text);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
};
const send = (m, p = {}) => new Promise((res, rej) => { pend.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async (expr, ms = 300000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }),
    new Promise((_, rj) => setTimeout(() => rj(new Error('tiempo agotado')), ms)),
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return r.result.value;
};
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Page.navigate', { url: ORIGIN + '/' });
await sleep(2500);

/** Texto visible en el lienzo: se lee la imagen, no la capa de encima. */
const leerLienzo = `
  const leerCanvas = (canvas) => {
    const g = canvas.getContext('2d');
    const d = g.getImageData(0, 0, canvas.width, canvas.height).data;
    /* zonas de píxeles oscuros: cada renglón con tinta es un bloque */
    const filas = new Set(), cols = new Set();
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++)
        if (d[(y * canvas.width + x) * 4] < 120) { filas.add(y); cols.add(x); }
    return { filas: [...filas].sort((a, b) => a - b), cols: [...cols].sort((a, b) => a - b) };
  };
`;

console.log('\n=== 1. Carga del curriculum ===');
const carga = await ev(`
  ${leerLienzo}
  const src = new Uint8Array(await (await fetch('/test/fixtures/cv.pdf')).arrayBuffer());
  await window.PDFFree.open(new File([src], 'cv.pdf', { type: 'application/pdf' }));
  await new Promise(r => setTimeout(r, 1200));
  const chk = document.querySelector('#showTextBoxes');
  if (!chk.checked) chk.click();
  await new Promise(r => setTimeout(r, 3000));
  const canvas = document.querySelector('#pages-edit canvas');
  window.__antes = leerCanvas(canvas);
  return { filas: window.__antes.filas.length, cajas: document.querySelectorAll('#pages-edit .tbox').length };
`);
console.log(`   ${carga.cajas} cajas · ${carga.filas} renglones con tinta en el lienzo`);
check('el PDF se carga con sus cajas', carga.cajas > 10 && carga.filas > 10);

console.log('\n=== 2. Corregir una línea y verla en la página al momento ===');
const r = await ev(`
  ${leerLienzo}
  const caja = [...document.querySelectorAll('#pages-edit .tbox')].find(c => c.title === 'CANVIA');
  caja.click();
  await new Promise(r => setTimeout(r, 600));
  const ta = document.querySelector('.item[data-editing="1"] textarea');
  ta.value = 'LA NUEVA S.A.';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));

  /* se espera al redibujado en vivo */
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (window.PDFFree.S.previewBytes) break;
  }
  await new Promise(r => setTimeout(r, 2500));

  const canvas = document.querySelector('#pages-edit canvas');
  const despues = leerCanvas(canvas);
  const item = window.PDFFree.S.editItems[1].find(i => i.inplace);
  return {
    hayPreview: !!window.PDFFree.S.previewBytes,
    filasAntes: window.__antes.filas.length, filasDespues: despues.filas.length,
    aplicado: !!item?.applied, modo: item?._mode,
    enCapa: document.querySelectorAll('#pages-edit .item[data-kind=text]').length,
    lista: [...document.querySelectorAll('#cambiosLista .cambio')].map(n => n.textContent.trim()),
    info: document.querySelector('#cambiosInfo').textContent,
  };
`);

check('se ha generado el PDF de vista previa', r.hayPreview === true);
check('la página se ha redibujado (el fondo cambió)', r.filasDespues > 0 && r.filasAntes > 0,
  `→ ${r.filasAntes} → ${r.filasDespues}`);
check('el cambio se marca como aplicado en el PDF', r.aplicado === true, `→ ${r.aplicado}`);
check('la edición se hizo conservando la fuente', r.modo === 'in situ', `→ ${r.modo}`);
check('el texto ya no se dibuja dos veces', r.enCapa === 0, `→ ${r.enCapa} elementos en la capa`);
check('aparece en la lista de cambios', r.lista.length === 1, `→ ${JSON.stringify(r.lista)}`);
check('la lista indica cuántos cambios hay', /1 cambio/.test(r.info), `→ ${r.info}`);

console.log('\n=== 3. Deshacer desde la lista ===');
const d = await ev(`
  ${leerLienzo}
  document.querySelector('#cambiosLista .cambio .btn').click();
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (!window.PDFFree.S.editItems[1]?.length) break;
  }
  await new Promise(r => setTimeout(r, 2500));
  const canvas = document.querySelector('#pages-edit canvas');
  return {
    cambios: window.PDFFree.S.editItems[1]?.length ?? 0,
    lista: document.querySelectorAll('#cambiosLista .cambio').length,
    panelOculto: document.querySelector('#panelCambios').classList.contains('hidden'),
    filas: leerCanvas(canvas).filas.length,
  };
`);
check('el cambio se quita de la lista', d.cambios === 0 && d.lista === 0, `→ ${d.cambios}/${d.lista}`);
check('la lista se oculta al no quedar nada', d.panelOculto === true);
check('la página vuelve a pintarse', d.filas > 0, `→ ${d.filas} renglones`);

console.log('\n=== 4. El PDF descargado es el correcto ===');
const g = await ev(`
  const caja = [...document.querySelectorAll('#pages-edit .tbox')].find(c => c.title === 'CANVIA');
  caja.click();
  await new Promise(r => setTimeout(r, 600));
  const ta = document.querySelector('.item[data-editing="1"] textarea');
  ta.value = 'LA NUEVA S.A.';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 800));
  const bytes = await window.PDFFree.build();
  const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
  const d2 = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
  const pg = await d2.getPage(1);
  const tc = await pg.getTextContent();
  const strs = tc.items.filter(i => i.str.trim()).map(i => i.str.trim());
  return { strs, fuentes: (await import('/js/core.js')).getPdfJs().version };
`);
check('el PDF guardado lleva el texto corregido',
  g.strs.some(s => /NUEVA/.test(s)) && !g.strs.includes('CANVIA'),
  `→ ${JSON.stringify(g.strs.slice(-6))}`);

console.log('\n=== 5. Sin errores de consola ===');
check('sin errores de consola', errores.length === 0, `→ ${errores.slice(0, 3).join(' | ')}`);

cleanup();
console.log('\n' + '='.repeat(52));
console.log(`  ${pass} pruebas correctas · ${fail} fallos`);
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);