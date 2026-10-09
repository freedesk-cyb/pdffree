/* ============================================================
   pages.js — Organizar páginas: unir, dividir, rotar,
   reordenar, eliminar, duplicar y extraer.
   ============================================================ */
import { S, $, pageSize, renderPage, toast, status, busy, download, baseName, initPdfJs } from './core.js';
import { pageCell } from './layer.js';

let selection = new Set();
let gridMode = false;

export function initPages() {
  $('#pgRotL').addEventListener('click', () => rotateSel(-90));
  $('#pgRotR').addEventListener('click', () => rotateSel(90));
  $('#pgDel').addEventListener('click', deleteSel);
  $('#pgDup').addEventListener('click', duplicateSel);
  $('#pgMerge').addEventListener('click', () => $('#mergeInput').click());
  $('#mergeInput').addEventListener('change', e => mergeFiles(e.target.files));
  $('#pgExtract').addEventListener('click', extractRange);
  $('#pgSplitEvery').addEventListener('click', splitEvery);
  $('#pgGrid').addEventListener('click', toggleGrid);

  // selección por clic en las páginas
  document.addEventListener('click', e => {
    const cell = e.target.closest('.page[data-page]');
    if (!cell || !cell.closest('#pages-pages')) return;
    const p = +cell.dataset.page;
    if (e.shiftKey && selection.size) {
      const arr = [...selection].sort((a, b) => a - b);
      const from = Math.min(...arr), to = Math.max(...arr);
      for (let i = from; i <= to; i++) selection.add(i);
    } else if (e.ctrlKey || e.metaKey) {
      selection.has(p) ? selection.delete(p) : selection.add(p);
    } else {
      selection = new Set([p]);
    }
    paintSelection();
  });
}

function paintSelection() {
  $$s('.page[data-page]', $('#pages-pages')).forEach(c =>
    c.classList.toggle('selected', selection.has(+c.dataset.page)));
  $$s('.gcell', $('#pageGrid')).forEach(c =>
    c.classList.toggle('selected', selection.has(+c.dataset.page)));
  status(selection.size ? `${selection.size} página(s) seleccionada(s)` : 'Listo');
}
const $$s = (s, r) => [...r.querySelectorAll(s)];

function rotateSel(by) {
  if (!selection.size) return toast('Selecciona páginas primero', 'err');
  for (const p of selection) {
    const op = S.pageOps.find(o => o.type === 'rotate' && o.page === p);
    if (op) op.by = (op.by + by) % 360;
    else S.pageOps.push({ type: 'rotate', page: p, by });
  }
  dirty(); toast(`Rotación aplicada a ${selection.size} página(s)`, 'ok');
}

async function deleteSel() {
  if (!selection.size) return toast('Selecciona páginas primero', 'err');
  if (!confirm(`¿Eliminar ${selection.size} página(s)?`)) return;
  for (const p of selection) {
    S.pageOps.push({ type: 'delete', page: p });
  }
  const newSel = new Set();
  for (const p of selection) for (let d = 0; d <= 40; d++) if (!newSel.has(p - d)) newSel.add(p - d);
  selection = new Set;
  dirty(); toast('Páginas marcadas para eliminar. Guárdalo para aplicar.', 'ok');
}

function duplicateSel() {
  if (!selection.size) return toast('Selecciona páginas primero', 'err');
  // duplicar = insertar copia justo después: se registra como op 'duplicate'
  for (const p of [...selection]) S.pageOps.push({ type: 'duplicate', page: p });
  dirty(); toast('Páginas duplicadas al guardar.', 'ok');
}

async function mergeFiles(files) {
  if (!files || !files.length) return;
  busy(true, 'Uniendo PDFs…');
  try {
    const merged = await PDFLib.PDFDocument.create();
    for (const f of files) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const src = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    download(await merged.save(), 'fusionado.pdf');
    toast('PDFs unidos y descargados', 'ok');
  } catch (e) { toast('Error al unir: ' + e.message, 'err'); }
  busy(false, 'Listo');
}

function parseRange(txt, max) {
  const pages = new Set();
  for (const part of String(txt).split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = +m[1], b = m[2] ? +m[2] : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= max) pages.add(i);
  }
  return [...pages].sort((x, y) => x - y);
}

async function extractRange() {
  const list = parseRange($('#rangeText').value, S.jsDoc.numPages);
  if (!list.length) return toast('Rango no válido. Ej: 1-3,7', 'err');
  busy(true, 'Extrayendo…');
  try {
    const src = await PDFLib.PDFDocument.load(S.originalBytes, { ignoreEncryption: true });
    const out = await PDFLib.PDFDocument.create();
    // aplicar rotaciones antes de copiar
    for (const p of list) {
      const op = S.pageOps.find(o => o.type === 'rotate' && o.page === p);
      const sp = src.getPage(p - 1);
      if (op) sp.setRotation(PDFLib.degrees((op.by % 360 + 360) % 360));
    }
    const copies = await out.copyPages(src, list.map(p => p - 1));
    copies.forEach(p => out.addPage(p));
    download(await out.save(), baseName() + `-pags-${list.join('_')}.pdf`);
    toast(`Extraídas ${list.length} página(s)`, 'ok');
  } catch (e) { toast('Error: ' + e.message, 'err'); }
  busy(false, 'Listo');
}

async function splitEvery() {
  const n = Math.max(1, +$('#splitEvery').value || 1);
  const total = S.jsDoc.numPages;
  if (total / n < 2 && n === 1) { /* dividir de 1 en 1 = un archivo por página */ }
  busy(true, 'Dividiendo…');
  try {
    const src = await PDFLib.PDFDocument.load(S.originalBytes, { ignoreEncryption: true });
    const chunks = [];
    for (let i = 0; i < total; i += n) chunks.push([...Array(Math.min(n, total - i)).keys()].map(k => i + k));
    // agrupa en archivos de N páginas, pero como máximo 20 archivos para no saturar
    const zip = [];
    for (const ch of chunks) {
      const out = await PDFLib.PDFDocument.create();
      const copies = await out.copyPages(src, ch);
      copies.forEach(p => out.addPage(p));
      zip.push({ name: `parte-${String(ch[0] + 1).padStart(3, '0')}.pdf`, bytes: await out.save() });
    }
    if (zip.length === 1) {
      download(zip[0].bytes, baseName() + '-dividido.pdf');
      toast('Dividido en 1 archivo', 'ok');
    } else {
      downloadMany(zip);
      toast(`Generados ${zip.length} archivos`, 'ok');
    }
  } catch (e) { toast('Error: ' + e.message, 'err'); }
  busy(false, 'Listo');
}

function downloadMany(files) {
  // sin librerías externas: se descargan en serie con pequeño retardo
  files.forEach((f, i) => setTimeout(() => download(f.bytes, f.name), i * 350));
}

async function toggleGrid() {
  gridMode = !gridMode;
  $('#pageGrid').classList.toggle('hidden', !gridMode);
  $('#pages-pages').classList.toggle('hidden', gridMode);
  if (gridMode) await mountGrid();
}

async function mountGrid() {
  const cont = $('#pageGrid');
  cont.innerHTML = '';
  const n = S.jsDoc.numPages;
  for (let p = 1; p <= n; p++) {
    const cell = document.createElement('div');
    cell.className = 'gcell';
    cell.dataset.page = p;
    cell.draggable = true;
    const cv = document.createElement('canvas');
    cell.appendChild(cv);
    const lbl = document.createElement('div');
    lbl.className = 'lbl2';
    lbl.innerHTML = `<span>pág. ${p}</span>`;
    cell.appendChild(lbl);
    cont.appendChild(cell);
    renderPage(p, cv, 0.32);

    cell.addEventListener('dragstart', () => { cell.classList.add('dragging'); cell.dataset.src = p; });
    cell.addEventListener('dragend', () => cell.classList.remove('dragging'));
    cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('drag-over'); });
    cell.addEventListener('dragleave', () => cell.classList.remove('drag-over'));
    cell.addEventListener('drop', e => {
      e.preventDefault(); cell.classList.remove('drag-over');
      const src = +cell.dataset.src, dst = p;
      if (src === dst) return;
      // reordenar: registrar el nuevo orden completo
      const order = S.pageOrder ? [...S.pageOrder] : Array.from({ length: S.jsDoc.numPages }, (_, i) => i + 1);
      const [moved] = order.splice(order.indexOf(src), 1);
      order.splice(order.indexOf(dst), 0, moved);
      S.pageOrder = order;
      toast('Orden cambiado. Pulsa «Guardar PDF» para aplicar.', 'ok');
      dirty();
    });
    cell.addEventListener('click', () => {
      selection = new Set([p]); paintSelection();
    });
  }
  paintSelection();
}

function dirty() { window.dispatchEvent(new CustomEvent('pdf-dirty')); }

export function mountPages() {
  const cont = $('#pages-pages');
  if (!S.jsDoc) return;
  const n = S.jsDoc.numPages;
  if (cont.childElementCount) { paintSelection(); return; }
  for (let p = 1; p <= n; p++) {
    const cell = pageCell(p, cont);
    const cv = document.createElement('canvas');
    cell.appendChild(cv);
    renderPage(p, cv, 0.55);
  }
  paintSelection();
}

export function resetPageSelection() { selection = new Set(); }
export function markSelected(set) { selection = set; paintSelection(); }
export function pageSelection() { return selection; }
export function dirtyFn() { dirty(); }