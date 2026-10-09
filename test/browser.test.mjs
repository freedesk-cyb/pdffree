/* ============================================================
   browser.test.mjs — Prueba end-to-end en Chrome real (headless).
   Levanta el servidor, abre la web, carga un PDF, aplica cambios
   y comprueba que:
     · no hay ni una petición a un servidor externo,
     · la interfaz se monta,
     · editar + guardar produce un PDF válido.

   Uso:  node test/browser.test.mjs
   ============================================================ */
import { spawn } from 'node:child_process';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8123;
const CDP_PORT = 9333;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const CHROME = CHROME_CANDIDATES.find(existsSync);
if (!CHROME) { console.error('No se encontró Chrome ni Edge.'); process.exit(1); }

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- procesos ---------------- */
const profile = resolve(here, 'out/chrome-profile');
await rm(profile, { recursive: true, force: true });
await mkdir(profile, { recursive: true });

console.log('\nArrancando servidor local…');
const server = spawn(process.execPath, [resolve(root, 'serve.mjs'), String(PORT)], {
  cwd: root, stdio: 'ignore',
});
console.log('Arrancando Chrome headless…');
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' });

const cleanup = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

/* esperar al puerto de depuración */
let ws = null;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (r.ok) break;
  } catch { /* aún no está */ }
  await sleep(250);
}
if (!existsSync(profile)) { /* noop */ }

/* ---------------- cliente CDP mínimo ---------------- */
let msgId = 0;
const pending = new Map();
const events = [];
let socket;

async function connect() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(ORIGIN + '/')}`, { method: 'PUT' });
  const target = await r.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });
  socket.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve: rs, reject: rj } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rj(new Error(JSON.stringify(m.error))) : rs(m.result);
    } else if (m.method) events.push(m);
  };
  return target;
}

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((rs, rj) => {
    pending.set(id, { resolve: rs, reject: rj });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
}

/* ---------------- prueba ---------------- */
try {
  console.log('\nConectando…');
  await connect();
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Page.enable');

  await send('Page.navigate', { url: ORIGIN + '/' });
  await sleep(2500);

  console.log('\n=== 1. Carga de la aplicación ===');
  const boot = await evaluate(`
    return {
      pdfLib: typeof PDFLib,
      fontkit: typeof window.fontkit,
      tesseract: typeof Tesseract,
      docx: typeof docx,
      mammoth: typeof mammoth,
      XLSX: typeof XLSX,
      api: typeof window.PDFFree,
      badge: document.querySelector('#netBadge')?.textContent.trim(),
      dropzone: !!document.querySelector('#dropzone'),
      tabs: document.querySelectorAll('#tabs .tab').length,
      modules: null,
    };
  `);
  check('el motor PDF está cargado', boot.pdfLib === 'object', `→ ${boot.pdfLib}`);
  check('fontkit (fuentes TTF) disponible', boot.fontkit === 'object', `→ ${boot.fontkit}`);
  check('Tesseract (OCR) disponible', boot.tesseract === 'object' || boot.tesseract === 'function', `→ ${boot.tesseract}`);
  check('generador de Word disponible', boot.docx === 'object', `→ ${boot.docx}`);
  check('lector de Word disponible', boot.mammoth === 'object', `→ ${boot.mammoth}`);
  check('motor de Excel disponible', boot.XLSX === 'object', `→ ${boot.XLSX}`);
  check('API pública expuesta', boot.api === 'object', `→ ${boot.api}`);
  check('las 8 pestañas están presentes', boot.tabs === 8, `→ ${boot.tabs}`);
  check('el indicador dice «100% offline»', /100% offline/.test(boot.badge || ''), `→ "${boot.badge}"`);

  console.log('\n=== 2. Privacidad: cero peticiones externas ===');
  await sleep(1200);
  const reqs = events.filter(e => e.method === 'Network.requestWillBeSent')
    .map(e => e.params.request.url);
  const external = reqs.filter(u => !u.startsWith(ORIGIN) && !u.startsWith('data:') && !u.startsWith('blob:'));
  check(`todas las peticiones son locales (${reqs.length} recursos)`, external.length === 0,
    `→ externas: ${JSON.stringify(external.slice(0, 5))}`);
  check('las librerías se sirven desde /vendor',
    reqs.filter(u => u.includes('/vendor/')).length >= 6,
    `→ ${reqs.filter(u => u.includes('/vendor/')).length}`);
  check('no se pide favicon externo', !reqs.some(u => u.includes('favicon') && !u.startsWith(ORIGIN)));

  console.log('\n=== 3. Abrir un PDF real ===');
  const opened = await evaluate(`
    const bytes = new Uint8Array(await (await fetch('/test/out/origen.pdf')).arrayBuffer());
    const file = new File([bytes], 'factura.pdf', { type: 'application/pdf' });
    await window.PDFFree.open(file);
    await new Promise(r => setTimeout(r, 800));
    return {
      pages: window.PDFFree.pages(),
      name: document.querySelector('#docName').textContent,
      meta: document.querySelector('#docMeta').textContent,
      workspaceVisible: !document.querySelector('#workspace').classList.contains('hidden'),
      canvases: document.querySelectorAll('#pages-edit canvas').length,
    };
  `);
  check('el PDF se abre y detecta 1 página', opened.pages === 1, `→ ${opened.pages}`);
  check('la interfaz pasa a modo edición', opened.workspaceVisible === true);
  check('el nombre del archivo se muestra', opened.name === 'factura.pdf', `→ ${opened.name}`);
  check('la página se renderiza en canvas', opened.canvases >= 1, `→ ${opened.canvases} canvas`);
  check('los metadatos indican que tiene texto', /con texto/.test(opened.meta), `→ "${opened.meta}"`);

  console.log('\n=== 4. Editar y guardar en el navegador ===');
  const edit = await evaluate(`
    const S = window.PDFFree.S;
    const P = 1.35;
    S.editItems = {
      1: [
        { kind:'cover', x:60*P, y:(841.89-712)*P, w:200*P, h:18*P, color:'#ffffff', pscale:P },
        { kind:'text',  x:60*P, y:(841.89-712)*P, w:300*P, h:18*P, pscale:P,
          text:'Total a pagar: 777,00 EUR', style:{ font:'Helvetica', size:12, color:'#003399', align:'left' } },
      ],
    };
    const bytes = await window.PDFFree.build();
    const magic = new TextDecoder().decode(bytes.slice(0, 5));
    const size = bytes.length;
    // pdf.js transfiere el buffer al worker y lo deja "detached": pasar copia
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
    let text = '';
    for (let i=1;i<=doc.numPages;i++){ text += (await (await doc.getPage(i)).getTextContent()).items.map(x=>x.str).join(' '); }
    return { size, magic, text };
  `);
  check('el PDF generado es válido (cabecera %PDF-)', edit.magic === '%PDF-', `→ "${edit.magic}"`);
  check('el texto corregido se puede leer del PDF', edit.text.includes('777,00 EUR'), `→ "${edit.text.slice(0, 80)}"`);
  check('el texto original se conserva', edit.text.includes('ACME'));
  check('tamaño razonable', edit.size > 900, `→ ${edit.size} B`);

  console.log('\n=== 5. Cambio de pestañas ===');
  const tabs = await evaluate(`
    const out = [];
    for (const t of document.querySelectorAll('#tabs .tab')) {
      t.click();
      await new Promise(r => setTimeout(r, 700));
      const panel = document.querySelector('#panel-' + t.dataset.tab);
      out.push({
        tab: t.dataset.tab,
        visible: panel.classList.contains('active'),
        canvases: panel.querySelectorAll('canvas').length,
      });
    }
    return out;
  `);
  for (const t of tabs) {
    check(`pestaña «${t.tab}» monta y renderiza`, t.visible && (t.tab === 'convert' || t.tab === 'protect' || t.canvases > 0),
      `→ visible=${t.visible} canvas=${t.canvases}`);
  }

  console.log('\n=== 6. Cifrado desde la interfaz ===');
  const enc = await evaluate(`
    document.querySelector('[data-tab="protect"]').click();
    document.querySelector('#encPw').value = 'clave123';
    // interceptar la descarga para no escribir en disco
    const oldCreate = URL.createObjectURL;
    let captured = null;
    URL.createObjectURL = b => { captured = b.size; return 'blob:fake'; };
    const a0 = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function(){};
    document.querySelector('#encRun').click();
    await new Promise(r => setTimeout(r, 2500));
    URL.createObjectURL = oldCreate;
    HTMLAnchorElement.prototype.click = a0;
    return { captured, out: document.querySelector('#protOut').textContent.slice(0, 200) };
  `);
  check('el cifrado produce un archivo', !!enc.captured, `→ ${enc.captured} B`);
  check('el panel confirma el algoritmo AES-256', /AES-256/.test(enc.out), `→ "${enc.out.trim().slice(0, 80)}"`);

  console.log('\n=== 7. Conversión a texto ===');
  const conv = await evaluate(`
    document.querySelector('[data-tab="convert"]').click();
    const a0 = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function(){};
    document.querySelector('#toTxt').click();
    await new Promise(r => setTimeout(r, 1500));
    HTMLAnchorElement.prototype.click = a0;
    return { out: (document.querySelector('#convOut').textContent||'').slice(0, 300) };
  `);
  check('la extracción de texto funciona', /FACTURA/.test(conv.out), `→ "${conv.out.trim().slice(0, 80)}"`);

  console.log('\n=== 8. Errores de consola ===');
  const errors = events.filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
    .map(e => e.params.entry.text);
  const exceptions = events.filter(e => e.method === 'Runtime.exceptionThrown')
    .map(e => e.params.exceptionDetails.text + ' ' + (e.params.exceptionDetails.exception?.description || ''));
  const real = [...errors, ...exceptions].filter(t => !/favicon/i.test(t));
  check('sin errores en consola', real.length === 0, `→ ${JSON.stringify(real.slice(0, 3))}`);

} catch (e) {
  fail++;
  console.log('  FAIL la prueba lanzó una excepción: ' + e.message);
} finally {
  cleanup();
}

console.log('\n' + '='.repeat(52));
console.log(`  ${pass} pruebas correctas · ${fail} fallos`);
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);