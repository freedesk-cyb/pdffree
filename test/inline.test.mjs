/* ============================================================
   inline.test.mjs — Editor en línea: edición de un fragmento dentro
   de una línea, sin diálogos, conservando la fuente incrustada.

   Reproduce el caso real: una fila con texto a la izquierda y una
   fecha a la derecha (dos bloques separados por un hueco grande).
   ============================================================ */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8131, CDP = 9341, ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  OK   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)); };

await mkdir(resolve(here, 'out'), { recursive: true });
const profile = resolve(here, 'out/chrome-inline');
await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
await mkdir(profile, { recursive: true });

const server = spawn(process.execPath, [resolve(root, 'serve.mjs'), String(PORT)], { cwd: root, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(250); }

const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(ORIGIN + '/')}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errs.push(m.params.entry.text);
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

console.log('\n=== 1. Carga y detección de bloques ===');
const r = await ev(`
  /* PDF con la fuente recortada al texto usado, como los PDF reales */
  const src = new Uint8Array(await (await fetch('/test/fixtures/subconjunto.pdf')).arrayBuffer());

  await window.PDFFree.open(new File([src], 'cv.pdf', { type: 'application/pdf' }));
  await new Promise(r => setTimeout(r, 1200));

  /* el PDF debe quedar editable al subirlo: las cajas se activan solas */
  const chk = document.querySelector('#showTextBoxes');
  const autoMarcada = chk.checked;
  if (!chk.checked) chk.click();
  await new Promise(r => setTimeout(r, 2500));

  const cajas = [...document.querySelectorAll('#pages-edit .tbox')];
  return {
    total: cajas.length,
    autoMarcada,
    titulos: cajas.map(c => c.title),
    status: document.querySelector('#status').textContent,
  };
`);
console.log('   cajas:', r.total, '· activadas al subir:', r.autoMarcada);
r.titulos.slice(0, 8).forEach(s => console.log('     · ' + JSON.stringify(s)));

check('el PDF se vuelve editable al subirlo (cajas activas solas)', r.autoMarcada === true);
check('se detectan las cajas de texto', r.total > 0, `→ ${r.total}`);
check('el título y la fecha son cajas SEPARADAS',
  r.titulos.some(s => /UNIVERSIDAD NORBERT/.test(s)) && r.titulos.some(s => /2020-2024/.test(s)),
  `→ ${JSON.stringify(r.titulos)}`);
check('el título NO se ha unido con la fecha',
  !r.titulos.some(s => /UNIVERSIDAD NORBERT WIENER\s+2020-2024/.test(s)));

console.log('\n=== 2. Editor en línea (sin diálogos) ===');
const e = await ev(`
  /* se comprueba que NO aparece ningún prompt: se reescribe para que rompa */
  let ventana = 0;
  window.prompt = () => { ventana++; return null; };
  const caja = [...document.querySelectorAll('#pages-edit .tbox')]
    .find(c => /Ingenieria/.test(c.title));
  caja.click();
  await new Promise(r => setTimeout(r, 600));

  const ta = document.querySelector('.item[data-editing="1"] textarea');
  const visible = ta ? getComputedStyle(ta).color : null;
  const fondo = ta ? getComputedStyle(ta).backgroundColor : null;
  const padre = ta ? ta.closest('.item')?.dataset.editing : null;
  const caja2 = ta ? ta.closest('.item').getBoundingClientRect() : null;
  const orig = caja.getBoundingClientRect();

  /* se escribe encima, como haría el usuario */
  ta.value = 'Ingenieria de sistemas e Informatica, con intereses en desarrollo.';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));

  const item = window.PDFFree.S.editItems[1].find(i => i.inplace);
  const fuenteUsada = ta ? getComputedStyle(ta).fontFamily : null;

  /* confirmar */
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 400));

  const bytes = await window.PDFFree.build();
  const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
  const d = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
  const tc = await (await d.getPage(1)).getTextContent();
  const lineas = tc.items.map(i => i.str.trim()).filter(Boolean);

  return {
    ventana,
    editorApareció: !!ta,
    colorTexto: visible,
    fondo, padre,
    alineado: caja2 ? Math.abs(caja2.left - orig.left) < 2 && Math.abs(caja2.top - orig.top) < 3 : false,
    fuenteUsada,
    textoItem: item?.text,
    modo: item?._mode,
    fuente: item?._fontUsed,
    lineas,
  };
`);

check('no se usa ningún diálogo (prompt)', e.ventana === 0, `→ ${e.ventana} diálogos`);
check('el editor aparece encima del texto', e.editorApareció);
check('el texto del editor se ve mientras se escribe',
  e.colorTexto && e.colorTexto !== 'rgba(0, 0, 0, 0)',
  `→ color ${e.colorTexto} fondo ${e.fondo} data-editing=${e.padre}`);
check('el editor está en la misma posición que el texto original', e.alineado === true);
check('el editor usa la fuente incrustada del PDF',
  /pdffont/.test(e.fuenteUsada || ''), `→ ${e.fuenteUsada}`);
check('el texto escrito queda en el elemento', /en desarrollo/.test(e.textoItem || ''), `-> ${e.textoItem}`);
check('la corrección se aplicó en el PDF con la fuente original',
  e.modo === 'in situ' && /Arial/i.test(e.fuente || ''), `→ ${e.modo} / ${e.fuente}`);
check('el texto corregido es legible en el PDF',
  e.lineas.some(l => /Ingenieria de sistemas e Informatica/.test(l)), `→ ${JSON.stringify(e.lineas.slice(0, 4))}`);
check('las demás líneas no se han roto',
  e.lineas.some(l => /UNIVERSIDAD NORBERT/.test(l)) && e.lineas.some(l => /2020-2024/.test(l)));

console.log('\n=== 3. Edición de un fragmento dentro de la línea ===');
const f = await ev(`
  /* recargar y editar SOLO una parte de la línea */
  const src0 = new Uint8Array(await (await fetch('/test/fixtures/subconjunto.pdf')).arrayBuffer());
  await window.PDFFree.open(new File([src0], 'r.pdf', { type:'application/pdf' }));
  await new Promise(r => setTimeout(r, 1200));
  const chk = document.querySelector('#showTextBoxes');
  if (!chk.checked) chk.click();          // solo si no estaba ya activo
  await new Promise(r => setTimeout(r, 2500));
  window.prompt = () => null;
  const caja = [...document.querySelectorAll('#pages-edit .tbox')].find(c => /Ingenieria/.test(c.title));
  caja.click();
  await new Promise(r => setTimeout(r, 500));
  const ta = document.querySelector('.item[data-editing="1"] textarea');
  /* el usuario selecciona SOLO una parte de la frase y escribe encima */
  const frase = ta.value;
  const i0 = frase.indexOf('con intereses');
  const i1 = frase.length;   /* desde «con intereses» hasta el final */
  ta.focus();
  ta.setSelectionRange(i0, i1);
  /* al pulsar una tecla el motor captura qué trozo se va a sustituir */
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
  /* y entonces el texto cambia */
  ta.value = frase.slice(0, i0) + 'en desarrollo.';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const bytes = await window.PDFFree.build();
  const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
  const d = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
  const tc = await (await d.getPage(1)).getTextContent();
  const item = window.PDFFree.S.editItems[1].find(i => i.inplace);
  return { lineas: tc.items.map(i => i.str.trim()).filter(Boolean), modo: item?._mode };
`);
check('sustituir solo un fragmento de la línea se hace en sitio', f.modo === 'in situ', `→ ${f.modo}`);
check('el resto de la frase se conserva', f.lineas.some(l => /Ingenieria de Sistemas e Informatica, en desarrollo\.$/.test(l)),
  `→ ${JSON.stringify(f.lineas.slice(0, 3))}`);

console.log('\n=== 4. Caracteres que no están en la fuente incrustada ===');
const g = await ev(`
  const src0 = new Uint8Array(await (await fetch('/test/fixtures/subconjunto.pdf')).arrayBuffer());
  await window.PDFFree.open(new File([src0], 'g.pdf', { type: 'application/pdf' }));
  await new Promise(r => setTimeout(r, 1200));
  const chk = document.querySelector('#showTextBoxes');
  if (!chk.checked) chk.click();
  await new Promise(r => setTimeout(r, 2500));
  window.prompt = () => null;
  [...document.querySelectorAll('#pages-edit .tbox')].find(c => /Ingenieria/.test(c.title)).click();
  await new Promise(r => setTimeout(r, 500));
  const ta = document.querySelector('.item[data-editing="1"] textarea');
  /* se piden letras que NO estaban en el documento (subconjunto) */
  ta.value = 'ZÑÑQÑ';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const bytes = await window.PDFFree.build();
  const item = window.PDFFree.S.editItems[1].find(i => i.inplace);
  return { modo: item?._mode, motivo: item?._inplaceError || '' };
`);
check('si el glifo no existe en la fuente, cae a sustitución', g.modo === 'sustitución', `→ ${g.modo}`);
check('el motivo está claro para el usuario', /glifo/i.test(g.motivo), `→ "${g.motivo}"`);

console.log('\n=== 5. Sin errores de consola ===');
const reales = errs.filter(t => !/favicon/i.test(t));
check('sin errores en consola', reales.length === 0, `→ ${JSON.stringify(reales.slice(0, 3))}`);

cleanup();
console.log('\n' + '='.repeat(52));
console.log(`  ${pass} pruebas correctas · ${fail} fallos`);
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);