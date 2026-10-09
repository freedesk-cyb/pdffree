import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '..');
const PORT = 8127, CDP = 9337, ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shots = resolve(here, 'out/shots');
await mkdir(shots, { recursive: true });
const profile = resolve(here, 'out/chrome-shot');
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

const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(shots, name + '.png'), Buffer.from(r.data, 'base64'));
  console.log('  captura:', name + '.png');
};

await shot('01-inicio');

// PDF de ejemplo con contenido
await ev(`
  const cv = document.createElement('canvas'); cv.width=1240; cv.height=1754;
  const g = cv.getContext('2d');
  g.fillStyle='#fff'; g.fillRect(0,0,cv.width,cv.height);
  g.fillStyle='#000';
  g.font='700 64px Arial'; g.fillText('CONTRATO DE ARRENDAMIENTO', 80, 160);
  g.font='34px Arial';
  ['Cliente: Empresa XYZ S.L.','NIF: B12345678','Importe mensual: 850,00 EUR','','Texto de la cláusula primera que se','modificará durante la edición.'].forEach((s,i)=>g.fillText(s,80,260+i*56));
  g.strokeStyle='#888'; g.strokeRect(80,520,1080,160);
  const doc = await PDFLib.PDFDocument.create();
  const p1 = doc.addPage([595.28,841.89]);
  p1.drawImage(await doc.embedPng(cv.toDataURL('image/png')), {x:0,y:0,width:595.28,height:841.89});
  const f2 = await PDFLib.PDFDocument.create();
  const f = await f2.embedFont(PDFLib.StandardFonts.Helvetica);
  const p2 = f2.addPage([595.28,841.89]);
  p2.drawText('ANEXO I - Documentacion adicional', {x:60,y:780,size:18,font:f});
  p2.drawText('Esta pagina tiene capa de texto real y es totalmente seleccionable.', {x:60,y:740,size:12,font:f});
  const merged = await PDFLib.PDFDocument.create();
  const a = await merged.copyPages(doc, [0]);
  const b = await merged.copyPages(f2, [0]);
  merged.addPage(a[0]); merged.addPage(b[0]);
  const bytes = await merged.save();
  await window.PDFFree.open(new File([bytes],'contrato.pdf',{type:'application/pdf'}));
  await new Promise(r=>setTimeout(r,1500));
  // simular una edición: tapar + texto nuevo
  const P=1.35, S=window.PDFFree.S;
  S.editItems = { 1: [
    { kind:'cover', x:80*P, y:(1754/841.89*841.89-841.89)*0+ (841.89-((260+3*56)/1754*841.89))*P, w:600*P, h:40*P, color:'#ffffff', pscale:P },
  ]};
  return true;
`);
await sleep(1200);
await shot('02-editor');

await ev(`document.querySelector('[data-tab="pages"]').click(); await new Promise(r=>setTimeout(r,1200));`);
await shot('03-paginas');
await ev(`document.querySelector('#pgGrid').click(); await new Promise(r=>setTimeout(r,1500));`);
await shot('04-miniaturas');
await ev(`document.querySelector('[data-tab="forms"]').click(); await new Promise(r=>setTimeout(r,1200));`);
await shot('05-formularios');
await ev(`document.querySelector('[data-tab="sign"]').click(); await new Promise(r=>setTimeout(r,600));
          document.querySelector('#sigName').value='Marta Ruiz';
          document.querySelector('#sigType').click();
          await new Promise(r=>setTimeout(r,900));`);
await shot('06-firma');
await ev(`document.querySelector('[data-tab="convert"]').click(); await new Promise(r=>setTimeout(r,600));
          document.querySelector('#toTxt').click(); await new Promise(r=>setTimeout(r,1500));`);
await shot('07-convertir');
await ev(`document.querySelector('[data-tab="protect"]').click(); await new Promise(r=>setTimeout(r,600));
          document.querySelector('#metaShow').click(); await new Promise(r=>setTimeout(r,900));`);
await shot('08-proteger');
await ev(`document.querySelector('[data-tab="annotate"]').click(); await new Promise(r=>setTimeout(r,1500));`);
await shot('09-anotar');
await ev(`document.querySelector('[data-tab="edit"]').click(); await new Promise(r=>setTimeout(r,600));
          document.querySelector('#showTextBoxes').click(); await new Promise(r=>setTimeout(r,1500));`);
await shot('10-cajas-texto');
process.exit(0);