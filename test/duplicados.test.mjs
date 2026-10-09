/* ============================================================
   duplicados.test.mjs — Corregir la misma línea varias veces no debe
   dejar el texto encima ni duplicado (lo que pasaba en el CV real:
   dos renglones superpuestos y la línea repetida).
   ============================================================ */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8181, CDP = 9391, ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  OK   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)); };

await mkdir(resolve(here, 'out'), { recursive: true });
const profile = resolve(here, 'out/chrome-dup');
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
  const leerLineas = async (bytes) => {
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    const d = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
    const pg = await d.getPage(1);
    const vp = pg.getViewport({ scale: 1 });
    const tc = await pg.getTextContent();
    return tc.items.filter(i => i.str.trim()).map(i => {
      const tr = pdfjs.Util.transform(vp.transform, i.transform);
      return { str: i.str.trim(), x: +tr[4].toFixed(1), y: +(vp.height - tr[5]).toFixed(1) };
    });
  };
`;

console.log('\n=== 1. Cargar el curriculum ===');
await ev(`
  ${LECTOR}
  const src = new Uint8Array(await (await fetch('/test/fixtures/cv.pdf')).arrayBuffer());
  await window.PDFFree.open(new File([src], 'cv.pdf', { type: 'application/pdf' }));
  await new Promise(r => setTimeout(r, 1200));
  const chk = document.querySelector('#showTextBoxes');
  if (!chk.checked) chk.click();
  await new Promise(r => setTimeout(r, 3000));
  window.__inicial = (await leerLineas(new Uint8Array(await (await fetch('/test/fixtures/cv.pdf')).arrayBuffer()))).length;
`);
check('el PDF carga', true);

console.log('\n=== 2. Corregir la MISMA línea tres veces seguidas ===');
const r = await ev(`
  ${LECTOR}
  const editar = async (titulo, nuevo) => {
    const c = [...document.querySelectorAll('#pages-edit .tbox')].find(x => x.title === titulo);
    if (!c) throw new Error('no hay caja: ' + titulo);
    c.click();
    await new Promise(r => setTimeout(r, 700));
    const ta = document.querySelector('.item[data-editing="1"] textarea');
    ta.value = nuevo;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 1500));
  };

  await editar('CANVIA', 'CANVIA S.A.');
  await editar('CANVIA', 'CANVIA S.A. DE TRANSPORTES');
  await editar('CANVIA', 'CANVIA TRANSPORTES');

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (window.PDFFree.S.previewBytes) break;
  }
  await new Promise(r => setTimeout(r, 2500));

  const bytes = await window.PDFFree.build();
  const lineas = await leerLineas(bytes);
  const cerca = lineas.filter(l => Math.abs(l.y - 265) < 30);
  return {
    cerca: cerca.map(l => \`y=\${l.y} "\${l.str}"\`),
    total: lineas.length,
    elementos: window.PDFFree.S.editItems[1].filter(i => i.kind === 'text').length,
    lista: [...document.querySelectorAll('#cambiosLista .cambio')].length,
  };
`);
console.log('   en la zona editada:');
r.cerca.forEach(l => console.log('     ' + l));
console.log('   total de líneas:', r.total, '· correcciones en la lista:', r.lista, '· elementos:', r.elementos);

check('solo queda UNA corrección para esa línea', r.elementos === 1, `→ ${r.elementos}`);
check('solo queda UNA línea en el PDF donde se editó',
  r.cerca.filter(s => /CANVIA/.test(s)).length === 1, `→ ${JSON.stringify(r.cerca)}`);
check('el texto final es el de la última corrección',
  r.cerca.some(s => /CANVIA TRANSPORTES/.test(s)), `→ ${JSON.stringify(r.cerca)}`);
check('no quedan restos de las correcciones anteriores',
  !r.cerca.some(s => /CANVIA S\\.A\\.|DE TRANSPORTES/.test(s)), `→ ${JSON.stringify(r.cerca)}`);
check('el documento no crece en líneas', r.total === 17, `→ ${r.total}`);
check('la lista muestra un solo cambio', r.lista === 1, `→ ${r.lista}`);

console.log('\n=== 3. Editar dos líneas distintas que se parecen ===');
const d = await ev(`
  ${LECTOR}
  const editar = async (titulo, nuevo) => {
    const c = [...document.querySelectorAll('#pages-edit .tbox')].find(x => x.title === titulo);
    c.click();
    await new Promise(r => setTimeout(r, 700));
    const ta = document.querySelector('.item[data-editing="1"] textarea');
    ta.value = nuevo;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 1500));
  };
  await editar('UNIVERSIDAD LAS AMERICAS', 'UNIVERSIDAD LAS AMERICAS');
  await editar('UNIVERSIDAD NORBERT WIENER', 'UNIVERSIDAD TECNOLOXICA');
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (window.PDFFree.S.previewBytes) break;
  }
  await new Promise(r => setTimeout(r, 2500));
  const bytes = await window.PDFFree.build();
  const lineas = await leerLineas(bytes);
  return {
    titulos: lineas.filter(l => /UNIVERSIDAD/.test(l.str)).map(l => \`y=\${l.y} "\${l.str}"\`),
    total: lineas.length,
  };
`);
console.log('   títulos:');
d.titulos.forEach(l => console.log('     ' + l));
check('las dos universidades se corrigen por separado',
  d.titulos.filter(s => /UNIVERSIDAD/.test(s)).length === 2, `→ ${JSON.stringify(d.titulos)}`);
check('cada una conserva su línea base',
  new Set(d.titulos.map(s => s.match(/y=([\d.]+)/)?.[1])).size === 2,
  `→ ${JSON.stringify(d.titulos)}`);
check('el documento sigue con 17 líneas', d.total === 17, `→ ${d.total}`);

console.log('\n=== 4. Errores de consola ===');
check('sin errores en consola', errores.length === 0, `→ ${errores.slice(0, 3).join(' | ')}`);

cleanup();
console.log('\n' + '='.repeat(52));
console.log(`  ${pass} pruebas correctas · ${fail} fallos`);
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);