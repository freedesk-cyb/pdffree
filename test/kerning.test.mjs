/* ============================================================
   kerning.test.mjs — Corrige una línea dibujada con kerning (TJ, la que
   salía duplicada) y comprueba que:
     · el texto NO se repite
     · no se pierde ni una letra del principio
     · el orden, la línea base y el margen se mantienen
   ============================================================ */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8195, CDP = 9405, ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  OK   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)); };

await mkdir(resolve(here, 'out'), { recursive: true });
const profile = resolve(here, 'out/chrome-kern');
await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
await mkdir(profile, { recursive: true });

const server = spawn(process.execPath, [resolve(root, 'serve.mjs'), String(PORT)], { cwd: root, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
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
      return { str: i.str.trim(), x: +tr[4].toFixed(1),
               y: +(vp.height - tr[5]).toFixed(1), w: +i.width.toFixed(1) };
    }).sort((a, b) => b.y - a.y);
  };
`;

console.log('\n=== 1. Cargar el curriculum con kerning ===');
const c = await ev(`
  ${LECTOR}
  const src = new Uint8Array(await (await fetch('/test/fixtures/cv-kerning.pdf')).arrayBuffer());
  await window.PDFFree.open(new File([src], 'cv-kerning.pdf', { type: 'application/pdf' }));
  await new Promise(r => setTimeout(r, 1200));
  const chk = document.querySelector('#showTextBoxes');
  if (!chk.checked) chk.click();
  await new Promise(r => setTimeout(r, 3500));
  window.__orig = await leerLineas(new Uint8Array(await (await fetch('/test/fixtures/cv-kerning.pdf')).arrayBuffer()));
  return {
    lineas: window.__orig.length,
    cajas: document.querySelectorAll('#pages-edit .tbox').length,
    larga: window.__orig.find(l => /redes y seguridad/.test(l.str)),
  };
`);
console.log(`   ${c.lineas} líneas · ${c.cajas} cajas`);
console.log('   línea larga:', JSON.stringify(c.larga));
check('las 15 líneas se detectan', c.lineas === 15, `→ ${c.lineas}`);
check('la línea con kerning se lee completa', (c.larga?.str || '').length > 70,
  `→ ${JSON.stringify(c.larga?.str)}`);

console.log('\n=== 2. Corregir esa línea (caso del duplicado) ===');
const r = await ev(`
  ${LECTOR}
  const caja = [...document.querySelectorAll('#pages-edit .tbox')]
    .find(x => /redes y seguridad/.test(x.title));
  if (!caja) return { error: 'no hay caja: ' + JSON.stringify([...document.querySelectorAll('#pages-edit .tbox')].map(c => c.title)) };
  caja.click();
  await new Promise(r => setTimeout(r, 700));
  const ta = document.querySelector('.item[data-editing="1"] textarea');
  ta.value = 'Ingeniería de Sistemas e Informática, con interés en desarrollo, soporte TI, redes y seguridad';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (window.PDFFree.S.previewBytes) break;
  }
  await new Promise(r => setTimeout(r, 2500));
  const bytes = await window.PDFFree.build();
  const lineas = await leerLineas(bytes);
  const orig = window.__orig;
  const antes = orig.find(l => /redes y seguridad/.test(l.str));
  const ahora = lineas.find(l => Math.abs(l.y - 466) < 3);
  const item = window.PDFFree.S.editItems[1].find(i => i.inplace);
  return {
    antes, ahora, modo: item?._mode, motivo: item?._inplaceError || '',
    total: lineas.length,
    zona: lineas.filter(l => Math.abs(l.y - 466) < 20).map(l => \`y=\${l.y} "\${l.str}"\`),
  };
`);
if (r.error) { console.log('   ', r.error); process.exit(1); }
console.log('   antes:', JSON.stringify(r.antes));
console.log('   ahora:', JSON.stringify(r.ahora));
console.log('   zona :', JSON.stringify(r.zona));
console.log('   modo :', r.modo, r.motivo);

const esperada = 'Ingeniería de Sistemas e Informática, con interés en desarrollo, soporte TI, redes y seguridad';
check('la línea corregida sale EXACTA, sin repetir nada',
  r.ahora?.str === esperada, `→ ${JSON.stringify(r.ahora?.str)}`);
check('no hay texto duplicado en esa línea',
  r.zona.filter(s => /redes y seguridad/.test(s)).length === 1, `→ ${JSON.stringify(r.zona)}`);
check('no empieza por un trozo perdido ("Int de Sistemas")',
  (r.ahora?.str || '').startsWith('Ingeniería de Sistemas'), `→ ${JSON.stringify(r.ahora?.str?.slice(0, 30))}`);
check('la línea base se mantiene', r.antes && r.ahora && Math.abs(r.antes.y - r.ahora.y) < 1.5,
  `→ ${r.antes?.y} vs ${r.ahora?.y}`);
check('el margen izquierdo se mantiene', r.antes && r.ahora && Math.abs(r.antes.x - r.ahora.x) < 1.5,
  `→ ${r.antes?.x} vs ${r.ahora?.x}`);
check('se conserva la fuente del PDF', r.modo === 'in situ', `→ ${r.modo} ${r.motivo}`);
check('el documento sigue con 15 líneas', r.total === 15, `→ ${r.total}`);

console.log('\n=== 3. Corregir un fragmento dentro de la línea con kerning ===');
const f = await ev(`
  ${LECTOR}
  const caja = [...document.querySelectorAll('#pages-edit .tbox')]
    .find(x => /tecnológica/.test(x.title));
  caja.click();
  await new Promise(r => setTimeout(r, 700));
  const ta = document.querySelector('.item[data-editing="1"] textarea');
  /* se selecciona solo una palabra y se sustituye */
  ta.focus();
  ta.value = 'tecnológica del Perú';
  ta.setSelectionRange(0, 11);
  ta.dispatchEvent(new Event('beforeinput', { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  await new Promise(r => setTimeout(r, 200));
  ta.setSelectionRange(12, ta.value.length);
  ta.value = 'tecnológica del Perú';
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 1400));
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (window.PDFFree.S.previewBytes) break;
  }
  await new Promise(r => setTimeout(r, 2000));
  const bytes = await window.PDFFree.build();
  const lineas = await leerLineas(bytes);
  const item = window.PDFFree.S.editItems[1].find(i => i.original);
  return {
    zona: lineas.filter(l => Math.abs(l.y - 438) < 20).map(l => \`\${l.x}|\${l.str}\`),
    modo: item?._mode, motivo: item?._inplaceError || '',
    total: lineas.length,
  };
`);
console.log('   zona:', JSON.stringify(f.zona), '· modo:', f.modo, f.motivo);
check('la línea corta con kerning no se duplica',
  f.zona.filter(s => /tecnológica/.test(s)).length === 1, `→ ${JSON.stringify(f.zona)}`);
check('el documento conserva sus 15 líneas', f.total === 15, `→ ${f.total}`);

console.log('\n=== 4. Errores de consola ===');
check('sin errores en consola', errores.length === 0, `→ ${errores.slice(0, 3).join(' | ')}`);

cleanup();
console.log('\n' + '='.repeat(52));
console.log(`  ${pass} pruebas correctas · ${fail} fallos`);
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);