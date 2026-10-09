/* ============================================================
   sustitucion.test.mjs — El camino difícil: cuando la fuente incrustada
   NO tiene las letras del texto nuevo, la app tapa y escribe encima.
   Ahí es donde el texto se parte en varias líneas y el original asoma.
   ============================================================ */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8173, CDP = 9383, ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  OK   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)); };

await mkdir(resolve(here, 'out'), { recursive: true });
const profile = resolve(here, 'out/chrome-sust');
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
      return { str: i.str.trim(), x: +tr[4].toFixed(1), y: +(vp.height - tr[5]).toFixed(1),
               w: +i.width.toFixed(1) };
    });
  };
`;

console.log('\n=== 1. Cargar el curriculum ===');
const c = await ev(`
  ${LECTOR}
  const src = new Uint8Array(await (await fetch('/test/fixtures/cv.pdf')).arrayBuffer());
  await window.PDFFree.open(new File([src], 'cv.pdf', { type: 'application/pdf' }));
  await new Promise(r => setTimeout(r, 1200));
  const chk = document.querySelector('#showTextBoxes');
  if (!chk.checked) chk.click();
  await new Promise(r => setTimeout(r, 3000));
  const caja = [...document.querySelectorAll('#pages-edit .tbox')].find(x => x.title === 'CANVIA');
  return { lineas: (await leerLineas(new Uint8Array(await (await fetch('/test/fixtures/cv.pdf')).arrayBuffer()))).length,
           ancho: parseFloat(caja.style.width) };
`);
console.log(`   ${c.lineas} líneas · la línea "CANVIA" mide ${Math.round(c.ancho)} px en pantalla`);
check('punto de partida: 17 líneas', c.lineas === 17);

console.log('\n=== 2. Texto largo con letras que la fuente NO tiene ===');
const r = await ev(`
  ${LECTOR}
  const caja = [...document.querySelectorAll('#pages-edit .tbox')].find(x => x.title === 'CANVIA');
  caja.click();
  await new Promise(r => setTimeout(r, 700));
  const ta = document.querySelector('.item[data-editing="1"] textarea');
  /* incluye G, Z, Q, K y dígitos ausentes: fuerza el modo sustitución */
  ta.value = 'GRUPO KAZBEK Y ZOCALO 3456789 SAC';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (window.PDFFree.S.previewBytes) break;
  }
  await new Promise(r => setTimeout(r, 2500));
  const bytes = await window.PDFFree.build();
  const lineas = await leerLineas(bytes);
  const item = window.PDFFree.S.editItems[1].find(i => i.inplace);
  return {
    modo: item?._mode, motivo: item?._inplaceError || '',
    cerca: lineas.filter(l => Math.abs(l.y - 265) < 60).map(l => \`y=\${l.y} "\${l.str}"\`),
    total: lineas.length,
  };
`);
console.log('   modo:', r.modo, r.motivo);
console.log('   líneas en la zona editada:');
r.cerca.forEach(l => console.log('     ' + l));
console.log('   total de líneas:', r.total);

check('el modo es sustitución (la fuente no trae esas letras)', r.modo === 'sustitución',
  `→ ${r.modo}`);
check('el texto nuevo NO se parte en varias líneas',
  r.cerca.filter(s => /GRUPO KAZBEK/.test(s)).length === 1,
  `→ ${JSON.stringify(r.cerca)}`);
check('el texto original desaparece del PDF (no queda debajo)',
  !r.cerca.some(s => s.includes('CANVIA')), `→ ${JSON.stringify(r.cerca)}`);
check('el documento no crece en líneas de texto', r.total === c.lineas,
  `→ ${c.lineas} → ${r.total}`);

cleanup();
console.log('\n' + '='.repeat(52));
console.log(`  ${pass} pruebas correctas · ${fail} fallos`);
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);