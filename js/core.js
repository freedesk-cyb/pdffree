/* ============================================================
   core.js — estado global, carga de PDF, render de páginas,
   utilidades de geometría y guardado.
   Sin dependencias externas más allá de pdf.js y pdf-lib.
   ============================================================ */

export const S = {
  /* --- pdf.js --- */
  jsDoc: null,
  jsPages: [],
  /* --- pdf-lib (documento de trabajo, sin cifrar) --- */
  outDoc: null,
  /* --- flags --- */
  hasTextLayer: false,
  /* Texto ya leído del PDF: pageNum -> getTextContent().
     pdf.js no siempre devuelve lo mismo si se le pide dos veces, así que
     se lee una sola vez y se reutiliza (ver textContentOf). */
  textContent: {},
  password: '',
  originalBytes: null,
  fileName: 'documento.pdf',
  /* --- operaciones pendientes sobre páginas --- */
  pageOps: [],           // [{page, rotate, deleted, id}]
  /* --- elementos de edición por página --- */
  editItems: {},         // pageNum -> [item]
  /* --- OCR --- */
  ocrText: '',           // texto plano reconocido (para guardar/exportar)
  ocrBoxes: {},          // pageNum -> [{words:[{x0,y0,x1,y1,text}], lang, fontSize}]
  /* --- formularios --- */
  formFields: [],        // campos creados [{page,name,type,x,y,w,h,options,value}]
  formValues: {},        // nombre -> valor al rellenar
  /* --- firmas/anotaciones --- */
  inkImages: {},         // pageNum -> dataURL
  annots: {},            // pageNum -> [{type,x1,y1,x2,y2,color,width,note}]
  /* --- historial --- */
  undo: [],
  /* --- vista previa en vivo (PDF ya editado, solo para pintar) --- */
  previewBytes: null,
  previewDoc: null,
};

export const $  = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ------------------------------------------------------------------ */
/* PDF.js                                                              */
/* ------------------------------------------------------------------ */
let pdfjsLib = null;

export async function initPdfJs() {
  const mod = await import('../vendor/pdfjs/pdf.min.mjs');
  pdfjsLib = mod;
  mod.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  return mod;
}
export function getPdfJs() { return pdfjsLib; }

/* ------------------------------------------------------------------ */
/* Cargar documento                                                    */
/* ------------------------------------------------------------------ */
export async function loadPdf(fileOrBytes, password = '') {
  let bytes = fileOrBytes;
  if (fileOrBytes instanceof ArrayBuffer) bytes = fileOrBytes;
  else if (fileOrBytes instanceof Uint8Array) bytes = fileOrBytes.buffer.slice(fileOrBytes.byteOffset, fileOrBytes.byteOffset + fileOrBytes.byteLength);
  else if (fileOrBytes instanceof Blob) bytes = await fileOrBytes.arrayBuffer();
  else if (typeof fileOrBytes === 'string') {
    const r = await fetch(fileOrBytes); bytes = await r.arrayBuffer();
  }

  const task = pdfjsLib.getDocument({
    data: bytes.slice(0),
    password,
    useSystemFonts: false,
    standardFontDataUrl: '../vendor/pdfjs/',
    cMapUrl: '../vendor/pdfjs/',
    cMapPacked: true,
  });

  const jsDoc = await task.promise;
  S.jsDoc = jsDoc;
  S.jsPages = [];
  S.hasTextLayer = false;
  resetVolatile();

  for (let i = 1; i <= jsDoc.numPages; i++) {
    const p = await jsDoc.getPage(i);
    S.jsPages.push(p);
    if (!S.hasTextLayer && p.getTextContent) {
      try {
        const tc = await textContentOf(i);
        if (tc.items.length) S.hasTextLayer = true;
      } catch { /* ignorado */ }
    }
  }

  try { await rebuildOutDoc(bytes, password); } catch (e) { console.warn('pdf-lib:', e.message); }
  return jsDoc;
}

/* Documento de trabajo en memoria (solo informativo; el guardado usa S.originalBytes) */
export async function rebuildOutDoc(bytes, password = '') {
  const src = bytes || S.originalBytes;
  if (!src) throw new Error('No hay documento cargado');
  const u8 = src instanceof Uint8Array ? src : new Uint8Array(src);
  S.outDoc = await PDFLib.PDFDocument.load(u8.slice(0), {
    ignoreEncryption: true, updateMetadata: false,
  });
  if (password) S.password = password;
  return S.outDoc;
}

export function resetVolatile() {
  S.pageOps = []; S.editItems = {}; S.ocrText = ''; S.ocrBoxes = {};
  S.formFields = []; S.formValues = {}; S.inkImages = {}; S.annots = {}; S.undo = [];
  /* OJO: el texto del documento (S.textContent) NO se limpia aquí. Ese texto
     solo se puede leer una vez de cada página (ver textContentOf), así que
     borrarlo obligaría a releerlo y saldría vacío. Se limpia al cargar otro
     documento, en loadPdf. */
}

/* ------------------------------------------------------------------ */
/* Geometría: coordenadas de pantalla <-> PDF                        */
/* ------------------------------------------------------------------ */
export function pageSize(pageNum) {
  const vp = S.jsPages[pageNum - 1].getViewport({ scale: 1 });
  return { width: vp.width, height: vp.height };
}

/** Convierte un punto de pantalla (relativo al canvas) a unidades PDF (origen abajo-izq.) */
export function screenToPdf(pt, pageNum, scale) {
  const { width, height } = pageSize(pageNum);
  return {
    x: pt.x / scale,
    y: height - pt.y / scale,
    w: (pt.w || 0) / scale,
    h: (pt.h || 0) / scale,
  };
}
export function pdfToScreen(p, pageNum, scale) {
  const { height } = pageSize(pageNum);
  return { x: p.x * scale, y: (height - p.y - p.h) * scale, w: p.w * scale, h: p.h * scale };
}

/* ------------------------------------------------------------------ */
/* Render de páginas                                                   */
/* ------------------------------------------------------------------ */
const renderCache = new Map();

export async function renderPage(pageNum, canvas, targetScale = 1.35, layerCanvas = null) {
  const page = S.jsPages[pageNum - 1];
  const vp1 = page.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = targetScale;
  const vp = page.getViewport({ scale: scale * dpr });

  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = Math.floor(vp.width / dpr) + 'px';
  canvas.style.height = Math.floor(vp.height / dpr) + 'px';

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, viewport: vp, intent: 'display' }).promise;

  if (layerCanvas) {
    layerCanvas.width = canvas.width;
    layerCanvas.height = canvas.height;
    layerCanvas.style.width = canvas.style.width;
    layerCanvas.style.height = canvas.style.height;
  }

  renderCache.set(pageNum, { scale, dpr, width: vp1.width, height: vp1.height });
  return { canvas, layerCanvas, scale, dpr, width: vp1.width, height: vp1.height };
}

/* ------------------------------------------------------------------ */
/* Vista previa en vivo: el PDF ya editado, redibujado en pantalla     */
/* ------------------------------------------------------------------ */
let previewDoc = null;

function destroyPreview() {
  if (!previewDoc) return;
  try { previewDoc.destroy(); } catch { /* ignorado */ }
  try { previewDoc.loadingTask?.destroy(); } catch { /* ignorado */ }
  previewDoc = null;
}

/**
 * Vuelve a pintar una página con el PDF YA EDITADO, para que lo que se ve
 * sea exactamente lo que se va a guardar. El documento original no se toca:
 * este es un pdf.js aparte, solo de vista previa.
 */
export async function renderPreviewPage(pageNum, canvas, scale = 1.35) {
  const bytes = S.previewBytes;
  if (!bytes) return null;

  destroyPreview();
  const task = pdfjsLib.getDocument({
    data: bytes.slice(0), useSystemFonts: false,
    standardFontDataUrl: '../vendor/pdfjs/', cMapUrl: '../vendor/pdfjs/', cMapPacked: true,
  });
  const doc = await task.promise;
  previewDoc = doc;
  S.previewDoc = doc;

  const page = await doc.getPage(pageNum);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale: scale * dpr });
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  canvas.style.width = Math.floor(vp.width / dpr) + 'px';
  canvas.style.height = Math.floor(vp.height / dpr) + 'px';
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, intent: 'display' }).promise;
  return { width: vp.width / dpr, height: vp.height / dpr };
}

/** Crea los bytes del PDF con todos los cambios aplicados (sin descargar). */
export async function buildPreviewBytes() {
  const { build } = await import('./writer.js');
  const bytes = await build();
  S.previewBytes = bytes;
  return bytes;
}

export function clearPreview() {
  S.previewBytes = null;
  destroyPreview();
}

/**
 * Documento del que se extrae el texto al exportar (Word, Excel, TXT…):
 * si hay cambios sin guardar, se exporta el PDF YA EDITADO, de modo que el
 * archivo lleva las correcciones. Si no hay cambios, el original.
 * Devuelve también la función para cerrar el documento temporal.
 */
export async function docParaExportar() {
  const cambios = Object.keys(S.editItems)
    .some(p => (S.editItems[p] || []).some(it => it.kind === 'text' && (it.text || '').trim()));
  if (!cambios || !S.previewBytes) return { doc: S.jsDoc, temporal: false, editado: false };

  const bytes = S.previewBytes;
  const task = pdfjsLib.getDocument({
    data: bytes.slice(0), useSystemFonts: false,
    standardFontDataUrl: '../vendor/pdfjs/', cMapUrl: '../vendor/pdfjs/', cMapPacked: true,
  });
  const doc = await task.promise;
  return {
    doc,
    temporal: true,
    editado: true,
    cerrar: () => { try { task.destroy(); } catch { /* ignorado */ } },
  };
}

export function renderInfo(pageNum) { return renderCache.get(pageNum); }

/* Obtiene las cajas de texto de una página, con la información tipográfica
   necesaria para reconstruir la línea sustituta respetando su formato.

   pdf.js devuelve el texto fragmentado (en fuentes monoespaciadas o con
   codificaciones raras, incluso un trozo por carácter). Aquí se reagrupa en
   LÍNEAS completas: sin esto, al pulsar sobre una línea el editor solo
   taparía un trozo suelto de ella. */
/* ------------------------------------------------------------------ */
/* Texto del documento                                                 */
/* ------------------------------------------------------------------ */
/**
 * pdf.js NO es fiable al pedir el texto dos veces de la misma página: la
 * segunda llamada devuelve CERO elementos, aunque el documento tenga texto
 * (medido: con el mismo archivo, la primera llamada da 21 y la segunda 0).
 *
 * Por eso el texto se lee UNA sola vez, nada más cargar el documento, y se
 * guarda aquí para siempre. Antes se releía al dibujar las cajas —porque al
 * montar la interfaz se vaciaba esta caché— y el documento salía vacío:
 * ninguna caja que editar.
 */
export async function textContentOf(pageNum) {
  const cache = S.textContent || (S.textContent = {});
  if (cache[pageNum]) return cache[pageNum];
  const page = S.jsPages[pageNum - 1];
  const tc = await page.getTextContent();
  /* una lectura vacía no sustituye a una buena: solo se guarda si trae texto */
  if (tc.items.length || !cache[pageNum]) cache[pageNum] = tc;
  return tc;
}

export async function getTextBoxes(pageNum) {
  const page = S.jsPages[pageNum - 1];
  const tc = await textContentOf(pageNum);
  return boxesFromTextContent(page, tc);
}

/**
 * Cajas de texto a partir de una página y su contenido ya leído.
 * Se separa para poder aplicarlo también al PDF YA EDITADO, que es lo que
 * se exporta a Word/Excel/TXT: así el archivo exportado lleva las
 * correcciones hechas en el editor.
 */
export function boxesFromTextContent(page, tc) {
  const vp = page.getViewport({ scale: 1 });
  const styles = tc.styles || {};

  /* pdf.js usa nombres internos (g_d0_f1) para las fuentes. Los sacamos
     del propio objeto de la fuente para saber cuál es la tipografía real
     (p.ej. "ArialNarrowMT"), que luego se relaciona con el recurso de
     fuente incrustado del PDF. */
  const fontNames = {};
  try {
    const objs = page.commonObjs;
    if (objs && typeof objs.get === 'function') {
      for (const item of tc.items) {
        if (fontNames[item.fontName]) continue;
        const o = objs.get(item.fontName);
        const n = o?.name || o?.fallbackName || o?.src || o?.data?.name || '';
        if (n) fontNames[item.fontName] = String(n);
      }
    }
  } catch { /* sin información: se usará la familia genérica */ }

  const raw = [];
  for (const item of tc.items) {
    if (!item.str || !item.str.trim()) continue;
    const tr = pdfjsLib.Util.transform(vp.transform, item.transform);
    const fontH = Math.hypot(tr[2], tr[3]) || Math.abs(tr[3]) || 10;
    raw.push({
      str: item.str,
      x: tr[4],
      y: tr[5] - fontH,
      w: item.width,
      h: fontH,
      baseline: vp.height - tr[5],
      size: fontH,
      family: (styles[item.fontName] || {}).fontFamily || 'sans-serif',
      fontName: item.fontName,
      realName: fontNames[item.fontName] || null,
    });
  }

  /* 1. agrupar por línea base */
  const lines = [];
  for (const it of raw.sort((a, b) => a.baseline - b.baseline || a.x - b.x)) {
    const tol = Math.max(0.7, it.size * 0.3);
    let line = lines.find(l => Math.abs(l.baseline - it.baseline) <= tol);
    if (!line) {
      line = { parts: [], baseline: it.baseline, size: it.size, family: it.family, fontName: it.fontName, realName: it.realName };
      lines.push(line);
    }
    line.parts.push(it);
    /* la tipografía real de la línea es la del primer fragmento */
    line.realName = line.realName || it.realName;
  }

  /* 2. unir los trozos de cada línea de izquierda a derecha */
  return lines.map(line => {
    const parts = line.parts.sort((a, b) => a.x - b.x);
    let str = '';
    let cursor = null;
    const gaps = [];
    for (const p of parts) {
      if (cursor !== null) {
        const gap = p.x - cursor;
        gaps.push(gap);
        /* hueco grande = palabra nueva; hueco pequeño = la fuente partió el texto */
        if (gap > p.size * 0.18) str += ' ';
      }
      str += p.str;
      cursor = p.x + p.w;
    }
    const first = parts[0], last = parts[parts.length - 1];
    const w = (last.x + last.w) - first.x;
    const top = Math.min(...parts.map(p => p.y));
    const bottom = Math.max(...parts.map(p => p.y + p.h));
    return {
      str: str.replace(/\s+/g, ' ').trim(),
      x: first.x,
      y: top,
      w, h: bottom - top,
      baseline: line.baseline,
      fontName: line.fontName,
      realName: line.realName,
      family: line.family,
      size: line.size,
      fontSize: line.size,
      parts: parts.length,
      gaps,
      /* Un hueco grande separa bloques distintos (p.ej. un título a la
         izquierda y una fecha a la derecha). Se exponen aparte para poder
         editar cada bloque por separado en vez de toda la fila. */
      blocks: splitBlocks(parts),
    };
  }).filter(b => b.str);
}

/** Divide una línea en bloques contiguos, cortando en los huecos grandes. */
function splitBlocks(parts) {
  const blocks = [];
  let cur = null;
  let cursor = null;
  for (const p of parts) {
    const gap = cursor === null ? 0 : p.x - cursor;
    if (!cur || gap > p.size * 2.2) {
      cur = { x: p.x, y: p.y, w: p.w, h: p.h, size: p.size, str: p.str, parts: [p] };
      blocks.push(cur);
    } else {
      cur.x = Math.min(cur.x, p.x);
      cur.parts.push(p);
      cur.str += (gap > p.size * 0.18 ? ' ' : '') + p.str;
      cur.w = (p.x + p.w) - cur.x;
      cur.y = Math.min(cur.y, p.y);
      cur.h = Math.max(cur.y + cur.h, p.y + p.h) - cur.y;
    }
    cursor = p.x + p.w;
  }
  return blocks.map(b => ({
    str: b.str.replace(/\s+/g, ' ').trim(),
    x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.w.toFixed(2), h: +b.h.toFixed(2),
    size: +b.size.toFixed(2),
  })).filter(b => b.str);
}

/* ------------------------------------------------------------------ */
/* Guardado / descarga                                                 */
/* ------------------------------------------------------------------ */
export function download(blobOrBytes, name) {
  const blob = blobOrBytes instanceof Blob ? blobOrBytes : new Blob([blobOrBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function baseName(name = S.fileName) { return name.replace(/\.pdf$/i, ''); }

export function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), kind === 'err' ? 6500 : 3200);
}
export function status(msg) { const s = $('#status'); if (s) s.textContent = msg; }
export function busy(on, msg) { status(on ? (msg || 'Procesando…') : (msg || 'Listo')); }

export function setProgress(el, pct) {
  const bar = el.querySelector('span');
  el.classList.toggle('hidden', pct == null);
  if (bar && pct != null) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

/* ------------------------------------------------------------------ */
/* Undo ligero                                                        */
/* ------------------------------------------------------------------ */
export function pushUndo(action, inverse) {
  S.undo.push({ action, inverse });
  if (S.undo.length > 60) S.undo.shift();
}
export function popUndo() { return S.undo.pop(); }

export async function loadFontkit() {
  if (!window.fontkit && window.FontKit) window.fontkit = window.FontKit;
  return window.fontkit;
}

export function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}