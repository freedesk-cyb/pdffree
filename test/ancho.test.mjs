/* ============================================================
   ancho.test.mjs — Al corregir una línea:
     · el texto nuevo debe TAPAR al original, no añadirse debajo
     · debe quedar en UNA sola línea, aunque sea más larga
     · el PDF descargado no debe dar error
   ============================================================ */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8171, CDP = 9381, ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  OK   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)); };

await mkdir(resolve(here, 'out'), { recursive: true });
const profile = resolve(here, 'out/chrome-ancho');
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

const LECTOR = `
  const leer = async (bytes) => {
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    const d = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
    const pg = await d.getPage(1);
    const tc = await pg.getTextContent();
    return tc.items.filter(i => i.str.trim()).map(i => {
      const tr = pdfjs.Util.transform(pg.getViewport({ scale: 1 }).transform, i.transform);
      return { str: i.str.trim(), x: +tr[4].toFixed(1), y: +(pg.getViewport({scale:1}).height - tr[5]).toFixed(1) };
    });
  };
`;

console.log('\n=== 1. Estado inicial ===');
const antes = await ev(`
  ${LECTOR}
  const src = new Uint8Array(await (await fetch('/test/fixtures/cv.pdf')).arrayBuffer());
  await window.PDFFree.open(new File([src], 'cv.pdf', { type: 'application/pdf' }));
  await new Promise(r => setTimeout(r, 1200));
  const chk = document.querySelector('#showTextBoxes');
  if (!chk.checked) chk.click();
  await new Promise(r => setTimeout(r, 3000));
  const caja = [...document.querySelectorAll('#pages-edit .tbox')].find(c => c.title === 'CANVIA');
  return {
    lineas: (await leer(new Uint8Array(await (await fetch('/test/fixtures/cv.pdf')).arrayBuffer()))).length,
    anchoCaja: parseFloat(caja.style.width), altoCaja: parseFloat(caja.style.height),
  };
`);
console.log(`   ${antes.lineas} líneas · caja ${Math.round(antes.anchoCaja)}×${Math.round(antes.altoCaja)} px`);
check('el PDF tiene 17 líneas', antes.lineas === 17, `→ ${antes.lineas}`);

console.log('\n=== 2. Sustituir por un texto MÁS LARGO ===');
const r = await ev(`
  ${LECTOR}
  const caja = [...document.querySelectorAll('#pages-edit .tbox')].find(c => c.title === 'CANVIA');
  caja.click();
  await new Promise(r => setTimeout(r, 700));
  const nodo = document.querySelector('.item[data-editing="1"]');
  const ta = nodo.querySelector('textarea');
  const antesEd = { w: parseFloat(nodo.style.width), h: nodo.style.height };

  /* texto bastante más largo que la línea original */
  ta.value = 'CANVIA DEL PERU SOCIEDAD ANONIMA DE SERVICIOS';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const alEscribir = { w: parseFloat(nodo.style.width), h: nodo.style.height, wrap: getComputedStyle(ta).whiteSpace };

  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (window.PDFFree.S.previewBytes) break;
  }
  await new Promise(r => setTimeout(r, 2500));

  const bytes = await window.PDFFree.build();
  const lineas = await leer(bytes);
  const item = window.PDFFree.S.editItems[1].find(i => i.inplace);
  const enLaZona = lineas.filter(l => Math.abs(l.y - 297) < 25 || /CANVIA/.test(l.str));
  return {
    antesEd, alEscribir,
    modo: item?._mode, motivo: item?._inplaceError || '',
    cerca: enLaZona.map(l => \`y=\${l.y} x=\${l.x} "\${l.str}"\`),
    totalLineas: lineas.length,
  };
`);

console.log('   caja al escribir:', JSON.stringify(r.alEscribir));
console.log('   modo:', r.modo, r.motivo);
console.log('   líneas cerca del cambio:');
r.cerca.forEach(l => console.log('     ' + l));
console.log('   total de líneas en el PDF:', r.totalLineas);

check('la caja NO crece en alto al escribir (no baja de línea)',
  parseFloat(r.alEscribir.h) <= parseFloat(r.antesEd.h) + 2,
  `→ ${r.antesEd.h} → ${r.alEscribir.h}`);
check('la caja crece en ANCHO para que quepa en una línea',
  parseFloat(r.alEscribir.w) > parseFloat(r.antesEd.w),
  `→ ${r.antesEd.w} → ${r.alEscribir.w}`);
check('el cambio entra en una sola línea del PDF',
  r.cerca.filter(s => /CANVIA/.test(s)).length === 1,
  `→ ${JSON.stringify(r.cerca)}`);
check('no se añade una línea extra',
  r.totalLineas === antes.lineas, `→ ${antes.lineas} → ${r.totalLineas}`);
check('se conserva la fuente del PDF', r.modo === 'in situ', `→ ${r.modo} ${r.motivo}`);

console.log('\n=== 3. El PDF descargado no da error ===');
const d = await ev(`
  ${LECTOR}
  window.__dl = null;
  const orig = URL.createObjectURL;
  URL.createObjectURL = (b) => { window.__dl = b; return orig(b); };
  const oc = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { window.__dlName = this.download; };
  document.querySelector('#saveBtn').click();
  await new Promise(r => setTimeout(r, 9000));
  const b = window.__dl;
  if (!b) return { sinDescarga: true, toasts: [...document.querySelectorAll('.toast')].map(n => n.textContent) };
  const buf = new Uint8Array(await b.arrayBuffer());
  let cab = ''; for (let i = 0; i < 8; i++) cab += String.fromCharCode(buf[i]);
  return {
    nombre: window.__dlName, cab, bytes: buf.length,
    toasts: [...document.querySelectorAll('.toast')].map(n => n.textContent),
    base64: btoa(String.fromCharCode(...buf)),
  };
`);
console.log('   descarga:', d.nombre, d.bytes, 'bytes');
console.log('   avisos:', JSON.stringify(d.toasts));
check('se descarga el PDF', /^%PDF-1\./.test(d.cab || ''), `→ ${JSON.stringify(d.cab)}`);
check('sin avisos de error', !(d.toasts || []).some(x => /Error/i.test(x)),
  `→ ${JSON.stringify(d.toasts)}`);

if (d.base64) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(resolve(here, 'out/ancho.pdf'), Buffer.from(d.base64, 'base64'));
  const { stubBrowser } = await import('./load-vendor.mjs');
  const PL = stubBrowser();
  try {
    const doc = await PL.PDFDocument.load(new Uint8Array(Buffer.from(d.base64, 'base64')),
      { ignoreEncryption: true, updateMetadata: false });
    check('el PDF descargado es válido', doc.getPageCount() === 1);
    await doc.save();
    check('se puede volver a abrir y guardar', true);
  } catch (e) {
    check('el PDF descargado es válido', false, `→ ${e.message}`);
  }
}

console.log('\n=== 4. Errores de consola ===');
check('sin errores en consola', errores.length === 0, `→ ${errores.slice(0, 3).join(' | ')}`);

cleanup();
console.log('\n' + '='.repeat(52));
console.log(`  ${pass} pruebas correctas · ${fail} fallos`);
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);