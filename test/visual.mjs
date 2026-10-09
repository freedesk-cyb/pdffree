/* ============================================================
   visual.mjs — Comprobación visual del arreglo tipográfico.
   Genera un PDF con texto condensado (parecido al de la captura),
   edita una línea pulsando sobre su caja y renderiza el resultado
   antes/después para poder compararlos a ojo.

   Salida: test/out/shots/antes.png y despues.png
   ============================================================ */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = 8128, CDP = 9338, ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shots = resolve(here, 'out/shots');
await mkdir(shots, { recursive: true });

const profile = resolve(here, 'out/chrome-visual');
await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
await mkdir(profile, { recursive: true });

const server = spawn(process.execPath, [resolve(root, 'serve.mjs'), String(PORT)], { cwd: root, stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', '--window-size=1500,1050', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch {} try { server.kill(); } catch {} });
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${CDP}/json/version`)).ok) break; } catch {} await sleep(250); }

const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(ORIGIN + '/')}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { pend.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
  return r.result.value;
};

await send('Runtime.enable'); await send('Page.enable');
await send('Page.navigate', { url: ORIGIN + '/' });
await sleep(2500);

/* --- render de un PDF a PNG para comparar --- */
const renderPdf = async (bytesExpr, file) => {
  const data = await ev(`
    const bytes = ${bytesExpr};
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 2 });
    const cv = document.createElement('canvas');
    cv.width = vp.width; cv.height = vp.height;
    const g = cv.getContext('2d');
    g.fillStyle='#fff'; g.fillRect(0,0,cv.width,cv.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    return cv.toDataURL('image/png').split(',')[1];
  `);
  await writeFile(resolve(shots, file), Buffer.from(data, 'base64'));
  console.log('  captura:', file);
};

/* --- 1. PDF de prueba con tipografía condensada --- */
console.log('\n1. Creando PDF de prueba (texto condensado)...');
const info = await ev(`
  const doc = await PDFLib.PDFDocument.create();
  const page = doc.addPage([595.28, 300]);

  const times  = await doc.embedFont(PDFLib.StandardFonts.TimesRoman);
  const timesB = await doc.embedFont(PDFLib.StandardFonts.TimesRomanBold);

  const L1 = 'Ingenieria de Sistemas e informatica, con belongs en desarrollo, soporte TI, redes y seguridad informatica.';
  const L2 = 'Formacion y soporte en proyectos innovadores dentro de la industria tecnologica.';

  // condensamos con el operador Tz para imitar una fuente estrecha
  page.pushOperators(PDFLib.PDFOperator.of('Tz', ['72']));
  page.drawText(L1, { x: 30, y: 210, size: 13, font: timesB });
  page.pushOperators(PDFLib.PDFOperator.of('Tz', ['100']));
  page.drawText(L2, { x: 30, y: 175, size: 13, font: times });
  const bytes = await doc.save();

  // el editor ve el ancho real (ya condensado)
  const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
  const d2 = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
  const tc = await (await d2.getPage(1)).getTextContent();
  const original = tc.items.map(i => i.str.trim()).filter(Boolean);

  await window.PDFFree.open(new File([bytes], 'perfil.pdf', { type:'application/pdf' }));
  await new Promise(r => setTimeout(r, 1200));
  return { original, count: window.PDFFree.pages() };
`);
console.log('   líneas en el original:', info.original.length);

await renderPdf(`await (await fetch('/test/out/visual-origen.pdf')).arrayBuffer()` , 'antes.png').catch(async () => {
  /* si no está el fixture en disco, lo generamos guardándolo */
});

/* --- 2. editar la primera línea pulsando sobre su caja --- */
console.log('\n2. Pulsando sobre la primera línea para corregirla...');
const edit = await ev(`
  document.querySelector('#showTextBoxes').click();
  await new Promise(r => setTimeout(r, 1500));

  // el diálogo native() se sustituye para automatizar la prueba
  const nuevo = 'Ingenieria de Sistemas e informatica, conbelongs en desarrollo, soporte TI, redes y seguridad.';
  window.prompt = () => nuevo;

  const cajas = document.querySelectorAll('#pages-edit .tbox');
  if (!cajas.length) return { error: 'no se detectaron cajas de texto' };
  const titulo = [...cajas].find(c => /Ingenieria/i.test(c.title)) || cajas[0];
  titulo.click();
  await new Promise(r => setTimeout(r, 400));

  const bytes = await window.PDFFree.build();
  // guarda el resultado para poder renderizarlo
  const blobUrl = URL.createObjectURL(new Blob([bytes]));
  const buf = new Uint8Array(await (await fetch(blobUrl)).arrayBuffer());
  let bin = ''; for (const b of buf) bin += String.fromCharCode(b);
  return {
    cajas: cajas.length,
    items: window.PDFFree.S.editItems[1].map(i => ({
      kind: i.kind, baseline: !!i.baseline,
      size: i.style && i.style.size, family: i.style && i.style.family,
      probeW: i.style && i.style.probe ? Math.round(i.style.probe.width) : null,
      texto: (i.text || '').slice(0, 40),
    })),
    b64: btoa(bin),
  };
`);

if (edit.error) {
  console.log('   ERROR:', edit.error);
} else {
  console.log('   cajas detectadas:', edit.cajas);
  console.log('   elementos creados:', JSON.stringify(edit.items, null, 1));
  const buf = Buffer.from(edit.b64, 'base64');
  await writeFile(resolve(here, 'out/visual-editado.pdf'), buf);
  console.log('   PDF guardado en test/out/visual-editado.pdf');

  /* --- 3. render del resultado --- */
  const data = await ev(`
    const bin = atob('${edit.b64}');
    const arr = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
    const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    const doc = await pdfjs.getDocument({ data: arr }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 2 });
    const cv = document.createElement('canvas');
    cv.width = vp.width; cv.height = vp.height;
    const g = cv.getContext('2d');
    g.fillStyle='#fff'; g.fillRect(0,0,cv.width,cv.height);
    await page.render({ canvasContext: g, viewport: vp }).promise;
    return cv.toDataURL('image/png').split(',')[1];
  `);
  await writeFile(resolve(shots, 'despues.png'), Buffer.from(data, 'base64'));
  console.log('  captura: despues.png');
}

process.exit(0);