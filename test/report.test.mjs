/* ============================================================
   report.test.mjs — Comprueba las dos cosas que fallan al usuario:
     1. Convertir el PDF a Word (.docx) y que el archivo sea válido.
     2. Descargar el PDF con una línea editada y que no dé error,
        ni al generarlo ni al volverlo a abrir.
   ============================================================ */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8161, CDP = 9371, ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  OK   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)); };

await mkdir(resolve(here, 'out'), { recursive: true });
const profile = resolve(here, 'out/chrome-report');
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

/** Intercepta las descargas para poder mirar el archivo generado. */
async function capturarDescarga(accion) {
  await ev(`
    window.__dl = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = (b) => { window.__dl = b; return orig(b); };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { window.__dlName = this.download; };
    true;
  `);
  const res = await ev(accion);
  const d = await ev(`
    const b = window.__dl;
    if (!b) return { blob: null };
    const buf = new Uint8Array(await b.arrayBuffer());
    let cab = '';
    for (let i = 0; i < Math.min(8, buf.length); i++) cab += String.fromCharCode(buf[i]);
    return {
      nombre: window.__dlName || '', tipo: b.type || '', bytes: buf.length,
      cab, base64: btoa(String.fromCharCode(...buf.slice(0, 400000))),
    };
  `);
  return { ...res, descarga: d };
}

console.log('\n=== 1. Abrir el curriculum ===');
await ev(`
  const src = new Uint8Array(await (await fetch('/test/fixtures/cv.pdf')).arrayBuffer());
  await window.PDFFree.open(new File([src], 'cv.pdf', { type: 'application/pdf' }));
  await new Promise(r => setTimeout(r, 1200));
  const chk = document.querySelector('#showTextBoxes');
  if (!chk.checked) chk.click();
  await new Promise(r => setTimeout(r, 3000));
  true;
`);

console.log('\n=== 2. Convertir a Word ===');
const w = await capturarDescarga(`
  document.querySelector('[data-tab="convert"]').click();
  await new Promise(r => setTimeout(r, 800));
  document.querySelector('#toWord').click();
  await new Promise(r => setTimeout(r, 6000));
  const s = document.querySelector('#status').textContent;
  const t = [...document.querySelectorAll('.toast')].map(n => n.textContent);
  return { status: s, toasts: t };
`);
console.log('   estado:', w.status);
console.log('   avisos:', JSON.stringify(w.toasts));
console.log('   descarga:', w.descarga.nombre, w.descarga.bytes, 'bytes,', w.descarga.tipo);

check('se ha generado un archivo', !!w.descarga.blob || w.descarga.bytes > 0,
  `→ ${w.descarga.bytes} bytes`);
check('el archivo es un .docx (ZIP: PK\\x03\\x04)',
  (w.descarga.cab || '').startsWith('PK'), ' -> cabecera ' + JSON.stringify(w.descarga.cab));
check('el nombre termina en .docx', /\.docx$/i.test(w.descarga.nombre || ''),
  `→ ${w.descarga.nombre}`);
check('no hay aviso de error', !w.toasts.some(x => /Error/i.test(x)),
  `→ ${JSON.stringify(w.toasts)}`);
check('el peso es razonable para 17 líneas', w.descarga.bytes > 3000 && w.descarga.bytes < 5_000_000,
  `→ ${w.descarga.bytes}`);

if (w.descarga.base64) {
  const { writeFileSync } = await import('node:fs');
  const buf = Buffer.from(w.descarga.base64, 'base64');
  writeFileSync(resolve(here, 'out/palabra.docx'), buf);
  console.log('   guardado en test/out/palabra.docx');
}

console.log('\n=== 3. Editar una línea y descargar el PDF ===');
const p = await capturarDescarga(`
  document.querySelector('[data-tab="edit"]').click();
  await new Promise(r => setTimeout(r, 800));
  const editar = async (titulo, nuevo) => {
    const c = [...document.querySelectorAll('#pages-edit .tbox')].find(x => x.title === titulo);
    if (!c) throw new Error('no hay caja para ' + titulo);
    c.click();
    await new Promise(r => setTimeout(r, 700));
    const ta = document.querySelector('.item[data-editing="1"] textarea');
    ta.value = nuevo;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 1500));
  };
  await editar('UNIVERSIDAD NORBERT WIENER', 'UNIVERSIDAD NACIONAL');
  await editar('Especialista de soporte Service Desk N2', 'Especialista senior de soporte N1');
  await new Promise(r => setTimeout(r, 2500));

  /* se pulsa el botón real de guardar, como hace la persona */
  document.querySelector('#saveBtn').click();
  await new Promise(r => setTimeout(r, 8000));
  const s = document.querySelector('#status').textContent;
  const t = [...document.querySelectorAll('.toast')].map(n => n.textContent);
  return { status: s, toasts: t };
`);
console.log('   estado:', p.status);
console.log('   avisos:', JSON.stringify(p.toasts));
console.log('   descarga:', p.descarga.nombre, p.descarga.bytes, 'bytes');

check('se ha descargado un PDF', /^%PDF-1\.\d/.test(p.descarga.cab || ''), `→ cabecera ${JSON.stringify(p.descarga.cab)}`);
check('el nombre es del PDF editado', /-editado\.pdf$/i.test(p.descarga.nombre || ''),
  `→ ${p.descarga.nombre}`);
check('no hay aviso de error al guardar', !p.toasts.some(x => /Error/i.test(x)),
  `→ ${JSON.stringify(p.toasts)}`);

if (p.descarga.bytes > 0) {
  const { writeFileSync } = await import('node:fs');
  const buf = Buffer.from(p.descarga.base64, 'base64');
  writeFileSync(resolve(here, 'out/editado.pdf'), buf);

  console.log('\n=== 4. Comprobar el PDF descargado con otras herramientas ===');
  const { stubBrowser, loadVendor } = await import('./load-vendor.mjs');
  const PL = stubBrowser();
  PL.PDFDocument && loadVendor('fontkit.umd.min.js');
  try {
    const doc = await PL.PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
    const n = doc.getPageCount();
    check('pdf-lib lo abre sin errores', n === 1, `→ ${n} páginas`);
    await doc.save();
    check('pdf-lib lo vuelve a guardar bien', true);
  } catch (e) {
    check('pdf-lib lo abre sin errores', false, `→ ${e.message}`);
  }
  try {
    const pdfjs = await import('file:///' + resolve(root, 'vendor/pdfjs/pdf.min.mjs').replace(/\\/g, '/'));
    pdfjs.GlobalWorkerOptions.workerSrc = 'file:///' + resolve(root, 'vendor/pdfjs/pdf.worker.min.mjs').replace(/\\/g, '/');
    const d = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false,
      standardFontDataUrl: 'file:///' + resolve(root, 'vendor/pdfjs/').replace(/\\/g, '/') + '/', cMapUrl: 'file:///' + resolve(root, 'vendor/pdfjs/').replace(/\\/g, '/') + '/', cMapPacked: true }).promise;
    const pg = await d.getPage(1);
    const tc = await pg.getTextContent();
    const strs = tc.items.filter(i => i.str.trim()).map(i => i.str.trim());
    check('pdf.js lo abre y extrae el texto', strs.length > 10, `→ ${strs.length} líneas`);
    check('el texto corregido está dentro', strs.some(s => /NACIONAL/.test(s)),
      `→ ${JSON.stringify(strs.filter(s => /UNIVERSIDAD/.test(s)))}`);
    check('el texto original se fue', !strs.includes('UNIVERSIDAD NORBERT WIENER'));
    check('la segunda corrección está', strs.some(s => /senior de soporte/.test(s)),
      `→ ${JSON.stringify(strs.filter(s => /soporte/.test(s)))}`);
  } catch (e) {
    check('pdf.js lo abre y extrae el texto', false, `→ ${e.message}`);
  }

  /* donde falla la gente: lo abre el visor del sistema / un lector */
  const limpio = !/%%EOF\s*$/.test(buf.toString('latin1').trimEnd() + ' ') ? 'no' : 'sí';
  check('el archivo termina correctamente', limpio === 'sí', '→ mal cerrado');
}

console.log('\n=== 5. Word después de editar: ¿lleva las correcciones? ===');
const w2 = await capturarDescarga(`
  document.querySelector('[data-tab="convert"]').click();
  await new Promise(r => setTimeout(r, 800));
  window.__dl = null;
  document.querySelector('#toWord').click();
  await new Promise(r => setTimeout(r, 8000));
  return { toasts: [...document.querySelectorAll('.toast')].map(n => n.textContent) };
`);
check('vuelve a generar el Word sin error', !w2.toasts.some(x => /Error/i.test(x)),
  `→ ${JSON.stringify(w2.toasts)}`);
if (w2.descarga.bytes > 0) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(resolve(here, 'out/palabra-editado.docx'),
    Buffer.from(w2.descarga.base64, 'base64'));
  console.log('   guardado en test/out/palabra-editado.docx');
}

console.log('\n=== 6. Errores de consola ===');
check('sin errores en consola durante todo el proceso', errores.length === 0,
  `→ ${errores.slice(0, 4).join(' | ')}`);

cleanup();
console.log('\n' + '='.repeat(52));
console.log(`  ${pass} pruebas correctas · ${fail} fallos`);
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);