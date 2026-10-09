/* ============================================================
   ocr.test.mjs — OCR real de extremo a extremo en Chrome.
   1) El navegador dibuja texto de verdad en un canvas.
   2) Se arma un PDF "escaneado" (solo imagen, sin capa de texto).
   3) Se pasa por el OCR de la app.
   4) Se comprueba que el PDF resultante es buscable.

   Uso:  node test/ocr.test.mjs      (tarda 1-3 min)
   ============================================================ */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8125, CDP = 9335, ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  OK   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

await mkdir(resolve(here, 'out'), { recursive: true });

/* ---------------- navegador ---------------- */
const profile = resolve(here, 'out/chrome-ocr');
await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => { });
await mkdir(profile, { recursive: true });

console.log('\n1. Arrancando servidor + Chrome headless…');
const server = spawn(process.execPath, [resolve(root, 'serve.mjs'), String(PORT)], { cwd: root, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(250); }

const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(ORIGIN + '/')}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push(m.params.entry.text);
};
const send = (method, params = {}) => new Promise((res, rej) => { pend.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr, ms = 600000) => {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }),
    new Promise((_, rj) => setTimeout(() => rj(new Error('tiempo agotado')), ms)),
  ]);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.navigate', { url: ORIGIN + '/' });
await sleep(3000);

console.log('2. Generando un PDF escaneado y pasándolo por el OCR…\n');
try {
  const r = await ev(`
    /* --- 2.1 crear una imagen con texto real y meterla en un PDF --- */
    const cv = document.createElement('canvas');
    cv.width = 1240; cv.height = 400;
    const g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, cv.width, cv.height);
    g.fillStyle = '#000000';
    g.font = '700 72px Arial, sans-serif';
    g.fillText('INVOICE 4471', 60, 120);
    g.font = '48px Arial, sans-serif';
    g.fillText('Total amount 1234.56 EUR', 60, 230);
    g.fillText('Client ACME SL Madrid', 60, 320);
    const pngUrl = cv.toDataURL('image/png');

    const doc = await PDFLib.PDFDocument.create();
    const page = doc.addPage([595.28, 192]);        // A4 a lo ancho
    const img = await doc.embedPng(pngUrl);
    page.drawImage(img, { x: 0, y: 0, width: 595.28, height: 192 });
    const bytes = await doc.save();

    /* --- 2.2 abrirlo en la app --- */
    await window.PDFFree.open(new File([bytes], 'factura-escaneada.pdf', { type:'application/pdf' }));
    await new Promise(r => setTimeout(r, 600));
    const metaAntes = document.querySelector('#docMeta').textContent;
    const teniaCapa = window.PDFFree.S.hasTextLayer;

    /* --- 2.3 OCR --- */
    document.querySelector('#ocrLang').value = 'eng';
    document.querySelector('[data-tab="ocr"]').click();
    await new Promise(r => setTimeout(r, 400));
    document.querySelector('#ocrRun').click();

    const t0 = Date.now();
    while (Date.now() - t0 < 540000) {
      await new Promise(r => setTimeout(r, 2000));
      if (window.PDFFree.S.ocrText && Object.keys(window.PDFFree.S.ocrBoxes).length) break;
    }
    await new Promise(r => setTimeout(r, 1500));

    const S = window.PDFFree.S;
    const cajas = Object.values(S.ocrBoxes)[0] || [];

    /* --- 2.4 comprobar que el PDF resultante es buscable --- */
    const out = await window.PDFFree.build();
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    const d2 = await pdfjs.getDocument({ data: out.slice(0) }).promise;
    let texto = '';
    for (let i=1;i<=d2.numPages;i++){
      texto += (await (await d2.getPage(i)).getTextContent()).items.map(x=>x.str).join(' ');
    }
    return {
      metaAntes, teniaCapa, statusFinal: document.querySelector('#status').textContent,
      lineas: cajas.length, palabrasOCR: (S.ocrText||'').trim().split(/\\s+/).filter(Boolean).length,
      textoExtraido: texto.trim(), palabras: texto.trim().split(/\\s+/).filter(Boolean).length,
      size: out.length, errorPaginas: /error/i.test(S.ocrText||'') ? 'sí' : 'no',
    };
  `);

  console.log(`     metadatos antes: "${r.metaAntes}"`);
  console.log(`     estado tras OCR: "${r.statusFinal}"`);
  console.log(`     texto reconocido: "${r.textoExtraido.slice(0, 140)}"`);
  console.log('');

  check('el PDF escaneado NO tenía capa de texto', r.teniaCapa === false, `→ ${r.teniaCapa}`);
  check('Tesseract produjo líneas de texto', r.lineas >= 3, `→ ${r.lineas} líneas`);
  check('se reconocieron palabras', r.palabrasOCR >= 6, `→ ${r.palabrasOCR} palabras`);
  check('el PDF resultante ahora es BUSCABLE', r.palabras >= 6, `→ ${r.palabras} palabras extraídas`);
  check('reconoce el importe «1234.56»', /1234|1234\.56/.test(r.textoExtraido), `→ "${r.textoExtraido.slice(0, 90)}"`);
  check('reconoce el cliente «ACME»', /ACME/i.test(r.textoExtraido));
  check('reconoce el número de factura «4471»', /4471/.test(r.textoExtraido));

  /* búsqueda real dentro del PDF resultante */
  const buscar = await ev(`
    const S = window.PDFFree.S;
    const out = await window.PDFFree.build();
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    const d = await pdfjs.getDocument({ data: out.slice(0) }).promise;
    const hits = [];
    for (let i=1;i<=d.numPages;i++){
      const tc = await (await d.getPage(i)).getTextContent();
      for (const it of tc.items) if (/ACME/i.test(it.str)) hits.push(it.str);
    }
    return hits;
  `);
  check('la búsqueda encuentra «ACME» dentro del PDF', buscar.length > 0, `→ ${JSON.stringify(buscar)}`);

} catch (e) {
  fail++;
  console.log('  FAIL la prueba OCR lanzó: ' + String(e.message).slice(0, 400));
}

cleanup();
console.log('\n' + '='.repeat(52));
console.log(`  ${pass} pruebas correctas · ${fail} fallos`);
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);