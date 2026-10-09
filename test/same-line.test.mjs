/* ============================================================
   same-line.test.mjs — Al editar una línea, se modifica ESA línea.
   Usa un PDF tipo curriculum con frases REPETIDAS y fechas a la
   derecha, que es donde el editor puede equivocarse.
   ============================================================ */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8135, CDP = 9345, ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  OK   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)); };

await mkdir(resolve(here, 'out'), { recursive: true });
const profile = resolve(here, 'out/chrome-same');
await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
await mkdir(profile, { recursive: true });

const server = spawn(process.execPath, [resolve(root, 'serve.mjs'), String(PORT)], { cwd: root, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1400,1100', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} };
process.on('exit', cleanup);
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(250); }

const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(ORIGIN + '/')}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (m, p = {}) => new Promise((res, rej) => { pend.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
const ev = async (expr, ms = 300000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }),
    new Promise((_, rj) => setTimeout(() => rj(new Error('tiempo agotado')), ms)),
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return r.result.value;
};
await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: ORIGIN + '/' });
await sleep(2500);

/** Extrae líneas del PDF con su posición y texto. */
const leerLineas = `
  const leer = async (bytes) => {
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    const d = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
    const pg = await d.getPage(1);
    const vp = pg.getViewport({ scale: 1 });
    const tc = await pg.getTextContent();
    return tc.items.filter(i => i.str.trim()).map(i => {
      const tr = pdfjs.Util.transform(vp.transform, i.transform);
      return { str: i.str.trim(), y: +(vp.height - tr[5]).toFixed(1), x: +tr[4].toFixed(1) };
    });
  };
`;

console.log('\n=== 1. Carga del PDF tipo curriculum ===');
const carga = await ev(`
  const src = new Uint8Array(await (await fetch('/test/fixtures/cv.pdf')).arrayBuffer());
  await window.PDFFree.open(new File([src], 'cv.pdf', { type: 'application/pdf' }));
  await new Promise(r => setTimeout(r, 1200));
  const chk = document.querySelector('#showTextBoxes');
  if (!chk.checked) chk.click();
  await new Promise(r => setTimeout(r, 3000));
  const cajas = [...document.querySelectorAll('#pages-edit .tbox')].map(c => ({
    t: c.title, x: Math.round(parseFloat(c.style.left)), y: Math.round(parseFloat(c.style.top)),
    w: Math.round(parseFloat(c.style.width)),
  }));
  ${leerLineas}
  return { cajas, lineas: await leer(new Uint8Array(await (await fetch('/test/fixtures/cv.pdf')).arrayBuffer())) };
`);

console.log(`   ${carga.cajas.length} cajas · ${carga.lineas.length} líneas`);
check('se detecta todo el texto', carga.cajas.length >= 14, `→ ${carga.cajas.length} cajas`);

const repetidas = carga.cajas.filter(c => /Ingenieria de Sistemas e Informatica$/.test(c.t));
console.log(`   cajas con texto repetido: ${repetidas.length} (posiciones y: ${repetidas.map(r => r.y).join(', ')})`);
check('las frases repetidas dan cajas separadas', repetidas.length >= 2, `→ ${repetidas.length}`);

console.log('\n=== 2. Editar la SEGUNDA línea repetida ===');
const r = await ev(`
  ${leerLineas}
  const cajas = [...document.querySelectorAll('#pages-edit .tbox')]
    .filter(c => /Ingenieria de Sistemas e Informatica$/.test(c.title))
    .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));

  /* se hace clic en la SEGUNDA (la de más abajo) */
  const objetivo = cajas[1];
  const yElegida = parseFloat(objetivo.style.top);
  objetivo.click();
  await new Promise(r => setTimeout(r, 600));

  const ta = document.querySelector('.item[data-editing="1"] textarea');
  const posEditor = ta ? ta.closest('.item').getBoundingClientRect().top : null;
  const posCaja = objetivo.getBoundingClientRect().top;

  ta.value = 'SISTEMAS E INORMACION';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 400));

  const bytes = await window.PDFFree.build();
  const item = window.PDFFree.S.editItems[1].find(i => i.inplace);
  return {
    yElegida,
    /* la caja pulsada es la de mayor "top" de pantalla = la de menor y */
    yEsperada: await leer(new Uint8Array(await (await fetch('/test/fixtures/cv.pdf')).arrayBuffer()))
      .then(l => l.filter(x => /Ingenieria/.test(x.str)).sort((a, b) => a.y - b.y)[0]?.y),
    alineado: posEditor !== null && Math.abs(posEditor - posCaja) < 3,
    lineas: await leer(bytes), modo: item?._mode, motivo: item?._inplaceError || '',
  };
`);

check('el editor aparece en la línea pulsada', r.alineado === true);
check('la edición se hizo en el PDF', r.modo === 'in situ', `→ ${r.modo} ${r.motivo}`);

const conNueva = r.lineas.filter(l => l.str.includes('SISTEMAS E INORMACION'));
check('la línea nueva existe', conNueva.length === 1, `→ ${JSON.stringify(conNueva)}`);
check('la línea nueva está en la posición de la caja pulsada',
  conNueva.length === 1 && Math.abs(conNueva[0].y - r.yEsperada) < 4,
  `→ y=${conNueva[0]?.y}, esperado ${r.yEsperada}`);

const antiguas = r.lineas.filter(l => /Ingenieria de Sistemas e Informatica/.test(l.str));
console.log('   líneas originales que siguen:', antiguas.length);
antiguas.forEach(l => console.log(`      y=${l.y} x=${l.x} "${l.str.slice(0, 50)}"`));

check('solo se modifica la línea pulsada (quedan 3 repetidas, no 4)',
  antiguas.length === 3, `→ quedan ${antiguas.length}, se esperaba 3`);
check('no se tocó la otra línea repetida',
  antiguas.length === 3
  && Math.abs(antiguas[0].y - conNueva[0].y) > 3,
  `→ y=${antiguas[0]?.y}`);

console.log('\n=== 3. Editar la línea de la derecha (fecha) ===');
const r2 = await ev(`
  ${leerLineas}
  const fecha = [...document.querySelectorAll('#pages-edit .tbox')].find(c => c.title === '2019');
  fecha.click();
  await new Promise(r => setTimeout(r, 600));
  const ta = document.querySelector('.item[data-editing="1"] textarea');
  ta.value = '2024';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const bytes = await window.PDFFree.build();
  const item = window.PDFFree.S.editItems[1].find(i => i.inplace);
  return { lineas: await leer(bytes), modo: item?._mode, motivo: item?._inplaceError || '' };
`);
check('la fecha se editó en sitio', r2.modo === 'in situ', `→ ${r2.modo} ${r2.motivo}`);
const fechas = r2.lineas.filter(l => /\d{4}/.test(l.str)).map(l => `${l.y}:${l.str}`);
console.log('   líneas con año:', JSON.stringify(fechas));
check('el año 2019 se sustituyó por 2024',
  !r2.lineas.some(l => l.str === '2019') && r2.lineas.some(l => l.str === '2024'),
  `→ ${JSON.stringify(fechas)}`);
check('las fechas de las demás líneas siguen intactas',
  r2.lineas.some(l => l.str === '2020-2024'), `→ ${JSON.stringify(r2.lineas.filter(l => /20\\d\\d/.test(l.str)).map(l => l.str))}`);

console.log('\n=== 4. El resto del documento no se toca ===');
check('el nombre sigue ahí', r2.lineas.some(l => /MAMANI MANDAMIENTO/.test(l.str)));
check('la empresa sigue ahí', r2.lineas.some(l => /CANVIA/.test(l.str)));
check('todas las líneas se conservan', r2.lineas.length >= carga.lineas.length,
  `→ ${r2.lineas.length} vs ${carga.lineas.length}`);

cleanup();
console.log('\n' + '='.repeat(52));
console.log(`  ${pass} pruebas correctas · ${fail} fallos`);
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);