/* ============================================================
   ocr.js — OCR en el navegador con Tesseract.js.
   Añade una capa de texto invisible (buscable + seleccionable)
   y permite revisar el texto reconocido.
   ============================================================ */
import { S, $, pageSize, toast, status, busy, setProgress, download } from './core.js';
import { pageCell } from './layer.js';

/* Rutas locales: nada de CDN. tesseract.js necesita tres cosas:
   · worker.min.js                → el hilo de trabajo
   · tesseract-core-*-lstm.wasm.js→ el motor (y su .wasm hermano)
   · traineddata/<lang>.gz        → los datos del idioma                    */
const WORKER_PATH = new URL('../vendor/tesseract/worker.min.js', import.meta.url).href;
const CORE_PATH = new URL('../vendor/tesseract/', import.meta.url).href;
const LANG_PATH = new URL('../vendor/traineddata', import.meta.url).href + '/';

let worker = null;
let workerLang = null;

async function getWorker(lang, onProg) {
  if (worker && workerLang === lang) return worker;
  if (worker) { try { await worker.terminate(); } catch { } worker = null; }
  worker = await Tesseract.createWorker(lang, 1, {
    workerPath: WORKER_PATH,
    corePath: CORE_PATH,
    langPath: LANG_PATH,
    gzip: true,
    logger: m => {
      if (m.status === 'recognizing text') onProg && onProg(m.progress);
      else status(m.status);
    },
    errorHandler: e => console.error('Tesseract:', e),
  });
  workerLang = lang;
  return worker;
}

export function initOcr() {
  $('#ocrRun').addEventListener('click', runOcr);
  $('#ocrTextView').addEventListener('click', showText);
  $('#ocrTextFile').addEventListener('click', () => {
    if (!S.ocrText) return toast('Primero ejecuta el OCR', 'err');
    download(new Blob([S.ocrText], { type: 'text/plain;charset=utf-8' }),
      (S.fileName.replace(/\.pdf$/i, '')) + '-ocr.txt');
  });
}

async function runOcr() {
  if (!S.jsDoc) return;
  const lang = $('#ocrLang').value;
  const prog = $('#ocrProg');
  busy(true, 'Iniciando OCR…');
  try {
    const w = await getWorker(lang, p => setProgress(prog, p * 100));

    S.ocrBoxes = {};
    let full = '';
    for (let p = 1; p <= S.jsDoc.numPages; p++) {
      status(`OCR página ${p} de ${S.jsDoc.numPages}…`);
      setProgress(prog, ((p - 1) / S.jsDoc.numPages) * 100);

      // render de la página a canvas para Tesseract
      const page = S.jsPages[p - 1];
      const vp = page.getViewport({ scale: 2 });
      const cv = document.createElement('canvas');
      cv.width = vp.width; cv.height = vp.height;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      const { data } = await w.recognize(cv, {}, { blocks: true, text: true });

      // pdf.js usa escala 1; Tesseract dio escala 2 → dividir por 2
      const words = [];
      if (data.blocks) {
        for (const blk of data.blocks) {
          for (const par of (blk.paragraphs || [])) {
            for (const line of (par.lines || [])) {
              for (const wd of (line.words || [])) {
                if (!wd.text || !wd.text.trim()) continue;
                words.push({
                  text: wd.text,
                  x0: wd.bbox.x0 / 2, y0: wd.bbox.y0 / 2,
                  x1: wd.bbox.x1 / 2, y1: wd.bbox.y1 / 2,
                });
              }
            }
          }
        }
      }
      //AGRupar en "líneas" por coordenada Y similar
      const lines = groupLines(words);
      S.ocrBoxes[p] = lines;
      full += `\n\n===== Página ${p} =====\n` + lines.map(l => l.text).join('\n');
      setProgress(prog, (p / S.jsDoc.numPages) * 100);
    }

    S.ocrText = full.trim();
    status('OCR completado');
    setProgress(prog, null);
    toast(`OCR listo: ${S.jsDoc.numPages} páginas Reconocidas. El PDF ya es buscable.`, 'ok');
    window.dispatchEvent(new CustomEvent('pdf-dirty'));
    showText();
  } catch (e) {
    console.error(e);
    toast('Error en OCR: ' + e.message, 'err');
    setProgress(prog, null);
  }
  busy(false, 'Listo');
}

function groupLines(words) {
  const out = [];
  for (const w of words) {
    let line = out.find(l => Math.abs(l.yTop - w.y0) < Math.max(4, (w.y1 - w.y0) * 0.5));
    if (!line) { line = { yTop: w.y0, words: [] }; out.push(line); }
    line.words.push(w);
  }
  return out.map(l => {
    l.words.sort((a, b) => a.x0 - b.x0);
    const x0 = Math.min(...l.words.map(w => w.x0));
    const x1 = Math.max(...l.words.map(w => w.x1));
    const y0 = Math.min(...l.words.map(w => w.y0));
    const y1 = Math.max(...l.words.map(w => w.y1));
    return {
      text: l.words.map(w => w.text).join(' '),
      x: x0, y: y0, w: x1 - x0, h: Math.max(y1 - y0, 8),
    };
  }).sort((a, b) => a.y - b.y);
}

function showText() {
  const out = $('#convOut');
  if (!S.ocrText) return toast('No hay texto OCR todavía', 'err');
  out.innerHTML = `<div class="card"><h3>Texto reconocido (edítalo aquí para corregirlo)</h3>
    <textarea id="ocrEditable" style="width:100%;height:300px">${S.ocrText.replace(/</g,'&lt;')}</textarea>
    <div style="margin-top:10px;display:flex;gap:8px">
      <button class="btn primary" id="ocrApplyText">Guardar correcciones</button>
      <button class="btn" id="ocrReapply">Volver a aplicar al PDF</button>
    </div>
    <p class="small muted" style="margin-top:8px">Al guardar correcciones se reconstruye la capa de texto buscable con tu texto. El diseño original se mantiene intacto debajo.</p>
  </div>`;

  $('#ocrApplyText').addEventListener('click', () => {
    S.ocrText = $('#ocrEditable').value;
    toast('Correcciones guardadas. Pulsa «Volver a aplicar» para regenerar el PDF.', 'ok');
  });
  $('#ocrReapply').addEventListener('click', async () => {
    // reconstruir S.ocrBoxes desde el texto editado, usando las cajas originales
    rebuildBoxesFromText();
    window.dispatchEvent(new CustomEvent('pdf-dirty'));
    toast('Capa de texto reconstruida. Usa «Guardar PDF».', 'ok');
  });
}

function rebuildBoxesFromText() {
  const lines = S.ocrText.split('\n');
  for (const pNum of Object.keys(S.ocrBoxes)) {
    const page = +pNum;
    const old = S.ocrBoxes[page];
    // tomar líneas de esta página del texto editado y reasignar a las cajas
    const startIdx = lines.findIndex(l => l.trim() === `===== Página ${page} =====`);
    if (startIdx < 0) continue;
    const seg = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (/^===== /.test(lines[i])) break;
      seg.push(lines[i]);
    }
    old.forEach((box, i) => { box.text = seg[i] != null ? seg[i] : ''; });
  }
}

/* Vista de páginas para el panel OCR */
export async function mountOcrPages() {
  const cont = $('#pages-ocr');
  if (!S.jsDoc || cont.childElementCount) return;
  const n = S.jsDoc.numPages;
  const step = n > 30 ? 3 : 1;
  for (let p = 1; p <= n; p += step) {
    const cell = pageCell(p, cont);
    const cv = document.createElement('canvas');
    cell.appendChild(cv);
    const { renderPage } = await import('./core.js');
    renderPage(p, cv, 0.5);
  }
  if (step > 1) cont.insertAdjacentHTML('afterbegin',
    `<p class="hint">Vista previa (1 de cada ${step}). El OCR sí se aplica a <b>todas</b> las páginas.</p>`);
}