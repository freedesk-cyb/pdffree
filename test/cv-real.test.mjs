/* ============================================================
   cv-real.test.mjs — Con el texto real del usuario (tildes, viñeta,
   párrafo de 3 renglones, años a la derecha) se corrige cada línea y se
   comprueba que se mantienen:
     · el ORDEN de las líneas
     · la ESCRITURA (el texto sale legible y con tildes)
     · los MÁRGENES (la posición horizontal no se mueve)
     · la línea base (no sube ni baja)
   Las tildes van en escapes para que el archivo no se corrompa.
   ============================================================ */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8191, CDP = 9401, ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* textos con tilde, escritos sin literales acentuados */
const ING = 'Ingenier\u00eda de Sistemas e Inform\u00e1tica';
const AMERICAS_TILDE = 'UNIVERSIDAD LAS AM\u00c9RICAS';
const EDUCACION = 'Educaci\u00f3n';
const PARRAFO1 = ING + ', con inter\u00e9s en desarrollo, soporte Ti, redes y seguridad';
const PARRAFO2 = 'inform\u00e1tica. Busco aprender y aportar en proyectos innovadores dentro de la industria';

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  OK   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)); };

await mkdir(resolve(here, 'out'), { recursive: true });
const profile = resolve(here, 'out/chrome-cvreal');
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

/* pasa los textos al navegador sin literales acentuados */
const EDICION = `
  const editar = async (titulo, nuevo) => {
    const c = [...document.querySelectorAll('#pages-edit .tbox')].find(x => x.title === titulo);
    if (!c) return 'no hay caja: ' + titulo;
    c.click();
    await new Promise(r => setTimeout(r, 700));
    const ta = document.querySelector('.item[data-editing="1"] textarea');
    ta.value = nuevo;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 1400));
  };
  const esperar = async () => {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (window.PDFFree.S.previewBytes) break;
    }
    await new Promise(r => setTimeout(r, 2500));
  };
`;

console.log('\n=== 1. Cargar el curriculum real ===');
const c = await ev(`
  ${LECTOR}
  const src = new Uint8Array(await (await fetch('/test/fixtures/cv-real.pdf')).arrayBuffer());
  await window.PDFFree.open(new File([src], 'cv-real.pdf', { type: 'application/pdf' }));
  await new Promise(r => setTimeout(r, 1200));
  const chk = document.querySelector('#showTextBoxes');
  if (!chk.checked) chk.click();
  await new Promise(r => setTimeout(r, 3500));
  window.__orig = await leerLineas(new Uint8Array(await (await fetch('/test/fixtures/cv-real.pdf')).arrayBuffer()));
  window.__T = ${JSON.stringify({ ING, AMERICAS_TILDE, EDUCACION, PARRAFO1, PARRAFO2 })};
  return {
    lineas: window.__orig.length,
    coords: window.__orig.map(l => l.y + '|' + l.x),
    cajas: document.querySelectorAll('#pages-edit .tbox').length,
  };
`);
console.log(`   ${c.lineas} líneas · ${c.cajas} cajas`);
check('se detectan las 15 líneas', c.lineas === 15, `-> ${c.lineas}`);
check('los tres renglones del párrafo salen por separado',
  c.coords.filter(s => /^(466|452|438)\|/.test(s)).length === 3,
  `-> ${c.coords.filter(s => /^(466|452|438)\|/.test(s)).length}`);

console.log('\n=== 2. Corregir una línea CON TILDES ===');
const r1 = await ev(`
  ${LECTOR}
  ${EDICION}
  const T = window.__T;
  await editar(T.AMERICAS_TILDE, 'UNIVERSIDAD LAS AMERICAS');
  await esperar();
  const bytes = await window.PDFFree.build();
  const lineas = await leerLineas(bytes);
  const antes = window.__orig.find(l => l.str === T.AMERICAS_TILDE);
  const ahora = lineas.find(l => l.str === 'UNIVERSIDAD LAS AMERICAS');
  const item = window.PDFFree.S.editItems[1].find(i => i.inplace);
  return {
    antes, ahora, modo: item?._mode, motivo: item?._inplaceError || '',
    total: lineas.length, coords: lineas.map(l => l.y + '|' + l.x),
  };
`);
console.log('   antes :', JSON.stringify(r1.antes));
console.log('   ahora :', JSON.stringify(r1.ahora));
console.log('   modo  :', r1.modo, r1.motivo);
check('la escritura es correcta', r1.ahora?.str === 'UNIVERSIDAD LAS AMERICAS',
  `-> ${JSON.stringify(r1.ahora?.str)}`);
check('la linea base NO cambia', r1.antes && r1.ahora && Math.abs(r1.antes.y - r1.ahora.y) < 1.5,
  `-> ${r1.antes?.y} vs ${r1.ahora?.y}`);
check('el margen izquierdo NO cambia', r1.antes && r1.ahora && Math.abs(r1.antes.x - r1.ahora.x) < 1.5,
  `-> ${r1.antes?.x} vs ${r1.ahora?.x}`);
check('se conserva la fuente del PDF', r1.modo === 'in situ', `-> ${r1.modo} ${r1.motivo}`);
check('el orden y la posicion de TODAS las lineas se mantienen',
  r1.coords.join('|') === c.coords.join('|'), '-> el orden cambio');
check('el documento sigue con 15 lineas', r1.total === 15, `-> ${r1.total}`);

console.log('\n=== 3. Corregir el parrafo largo (3 renglones) ===');
const r2 = await ev(`
  ${LECTOR}
  ${EDICION}
  const T = window.__T;
  await editar(T.PARRAFO1, T.PARRAFO1.replace('soporte Ti', 'soporte TI'));
  await esperar();
  const bytes = await window.PDFFree.build();
  const lineas = await leerLineas(bytes);
  const antes = window.__orig.find(l => l.str === T.PARRAFO1);
  const ahora = lineas.find(l => Math.abs(l.y - 466) < 1);
  return {
    antes, ahora, total: lineas.length,
    resto: lineas.filter(l => /Educaci|Lima|NORBERT|2019/.test(l.str)).map(l => l.y + '|' + l.str),
  };
`);
console.log('   antes:', JSON.stringify(r2.antes?.str?.slice(0, 60)));
console.log('   ahora:', JSON.stringify(r2.ahora?.str?.slice(0, 60)));
check('el parrafo se corrige entero, sin perder el principio',
  r2.ahora?.str === PARRAFO1.replace('soporte Ti', 'soporte TI'),
  `-> ${JSON.stringify(r2.ahora?.str?.slice(0, 60))}`);
check('el margen izquierdo del parrafo se mantiene',
  r2.antes && r2.ahora && Math.abs(r2.antes.x - r2.ahora.x) < 1.5,
  `-> ${r2.antes?.x} vs ${r2.ahora?.x}`);
check('la linea base del parrafo se mantiene',
  r2.antes && r2.ahora && Math.abs(r2.antes.y - r2.ahora.y) < 1.5,
  `-> ${r2.antes?.y} vs ${r2.ahora?.y}`);
check('las demas lineas siguen en su sitio', r2.resto.length === 5, `-> ${JSON.stringify(r2.resto)}`);
check('el documento sigue con 15 lineas', r2.total === 15, `-> ${r2.total}`);

console.log('\n=== 4. Corregir el nombre y la linea de la viñeta ===');
const r3 = await ev(`
  ${LECTOR}
  ${EDICION}
  await editar('MAMANI MANDAMIENTO EDWIN OMAR', 'MAMANI MANDAMIENTO EDWIN');
  await editar('\u2022 omar-28-01@hotmail.com \u2022 931786092',
               '\u2022 omar28-01@hotmail.com \u2022 931 786 092');
  await esperar();
  const bytes = await window.PDFFree.build();
  const lineas = await leerLineas(bytes);
  const o = window.__orig;
  return {
    nomOrig: o.find(l => /MAMANI/.test(l.str)),
    nomAhora: lineas.find(l => /MAMANI/.test(l.str)),
    viOrig: o.find(l => /omar-28/.test(l.str)),
    viAhora: lineas.find(l => /omar28/.test(l.str)),
    total: lineas.length,
    coords: lineas.map(l => l.y + '|' + l.x),
    ordenOrig: o.map(l => l.y),
  };
`);
console.log('   nombre antes:', JSON.stringify(r3.nomOrig));
console.log('   nombre ahora:', JSON.stringify(r3.nomAhora));
console.log('   viñeta antes:', JSON.stringify(r3.viOrig));
console.log('   viñeta ahora:', JSON.stringify(r3.viAhora));
check('el nombre se corrige bien', r3.nomAhora?.str === 'MAMANI MANDAMIENTO EDWIN',
  `-> ${JSON.stringify(r3.nomAhora?.str)}`);
check('el nombre conserva su centrado', r3.nomOrig && r3.nomAhora
  && Math.abs(r3.nomOrig.x - r3.nomAhora.x) < 1.5, `-> ${r3.nomOrig?.x} vs ${r3.nomAhora?.x}`);
check('la linea de la viñeta se corrige bien',
  r3.viAhora?.str === '\u2022 omar28-01@hotmail.com \u2022 931 786 092',
  `-> ${JSON.stringify(r3.viAhora?.str)}`);
check('la viñeta se conserva', (r3.viAhora?.str || '').startsWith('\u2022'),
  `-> ${JSON.stringify(r3.viAhora?.str)}`);
check('el documento sigue con 15 lineas', r3.total === 15, `-> ${r3.total}`);
check('el orden de las lineas NO cambia en ningun momento',
  r3.coords.every((s, i) => Math.abs(Number(s.split('|')[0]) - r3.ordenOrig[i]) < 0.05),
  `-> ${JSON.stringify(r3.coords)}`);

console.log('\n=== 5. Errores de consola ===');
check('sin errores en consola', errores.length === 0, `-> ${errores.slice(0, 3).join(' | ')}`);

cleanup();
console.log('\n' + '='.repeat(52));
console.log(`  ${pass} pruebas correctas - ${fail} fallos`);
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);