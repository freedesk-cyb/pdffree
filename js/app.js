/* ============================================================
   app.js — Orquestador: carga de archivos, pestañas,
   guardado y montaje de cada módulo.
   ============================================================ */
import {
  S, $, $$, initPdfJs, loadPdf, rebuildOutDoc, resetVolatile,
  toast, status, busy, download, baseName,
} from './core.js';
import { build } from './writer.js';
import { initEdit, mountEdit } from './edit.js';
import { initOcr, mountOcrPages } from './ocr.js';
import { initPages, mountPages } from './pages.js';
import { initForms, mountForms } from './forms.js';
import { initSign, mountSignPages } from './sign.js';
import { initConvert } from './convert.js';
import { initProtect } from './protect.js';
import { initAnnotate, mountAnnotate } from './annotate.js';

let dirty = false;
let currentTab = 'edit';
const mounted = new Set();

/* ------------------------------------------------------------------ */
/* Inicio                                                              */
/* ------------------------------------------------------------------ */
(async function boot() {
  await initPdfJs();
  initEdit(); initOcr(); initPages(); initForms(); initSign();
  initConvert(); initProtect(); initAnnotate();
  wireTabs();
  wireDropzone();
  wireSave();
  setBadge();
  console.log('%cPDF Free listo — todo el procesamiento ocurre en este navegador.',
    'color:#3fb950;font-weight:bold');
})();

/* Verifica que ninguna librería apunta a Internet */
function setBadge() {
  const ext = [...document.querySelectorAll('script[src],link[href]')]
    .map(n => n.src || n.href)
    .filter(u => u && !u.startsWith(location.origin) && !u.startsWith('data:'));
  if (ext.length) {
    $('#netBadge').innerHTML = `<span class="dot"></span> AVISO: ${ext.length} recurso(s) externo(s)`;
    $('#netBadge').style.color = '#d29922';
    $('#netBadge').style.borderColor = '#4a3a10';
    $('#netBadge').style.background = '#241d0c';
    console.warn('Recursos externos detectados:', ext);
  }
}

/* API pública para scripting y pruebas automatizadas.
   Ejemplo en la consola del navegador:
     PDFFree.open(archivo)          → abre un PDF
     PDFFree.save()                 → descarga el PDF con los cambios
     PDFFree.state                  → todo el estado del editor           */
window.PDFFree = {
  S, build, assemble, download,
  get doc() { return S.jsDoc; },
  open: (file) => openFile(file),
  save: () => save(),
  pages: () => S.jsDoc ? S.jsDoc.numPages : 0,
};

/* ------------------------------------------------------------------ */
/* Pestañas                                                            */
/* ------------------------------------------------------------------ */
function wireTabs() {
  $$('#tabs .tab').forEach(t => t.addEventListener('click', () => {
    $$('#tabs .tab').forEach(x => x.classList.remove('active'));
    $$('.panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    currentTab = t.dataset.tab;
    $('#panel-' + currentTab).classList.add('active');
    mountTab(currentTab);
  }));
}

function mountTab(tab) {
  if (mounted.has(tab) || !S.jsDoc) return;
  try {
    if (tab === 'edit') mountEdit();
    else if (tab === 'ocr') mountOcrPages();
    else if (tab === 'pages') mountPages();
    else if (tab === 'forms') mountForms();
    else if (tab === 'sign') mountSignPages();
    else if (tab === 'annotate') mountAnnotate();
    mounted.add(tab);
  } catch (e) {
    console.error(e);
    toast('No se pudo montar la pestaña: ' + e.message, 'err');
  }
}

/* ------------------------------------------------------------------ */
/* Carga de archivos                                                   */
/* ------------------------------------------------------------------ */
function wireDropzone() {
  const dz = $('#dropzone');
  const inp = $('#fileInput');

  dz.addEventListener('click', () => inp.click());
  inp.addEventListener('change', () => inp.files[0] && openFile(inp.files[0]));

  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => {
    e.preventDefault(); dz.querySelector('.dz-inner').classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => {
    e.preventDefault(); dz.querySelector('.dz-inner').classList.remove('over');
  }));
  dz.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (f) openFile(f);
  });
  // arrastrar sobre toda la ventana
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => {
    e.preventDefault();
    if (!dz.contains(e.target)) {
      const f = e.dataTransfer.files[0];
      if (f) openFile(f);
    }
  });
}

async function openFile(file) {
  status('Cargando…');
  busy(true, 'Abriendo ' + file.name);
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    S.originalBytes = buf;
    S.fileName = file.name;
    try {
      await loadPdf(buf, '');
      showWorkspace();
    } catch (e) {
      if (isPasswordError(e)) askPassword(buf);
      else throw e;
    }
  } catch (e) {
    console.error(e);
    toast('No se pudo abrir el PDF: ' + e.message, 'err');
  }
  busy(false, 'Listo');
}

function isPasswordError(e) {
  const m = String(e?.name || '') + String(e?.message || '');
  return /PasswordException|password/i.test(m);
}

function askPassword(buf) {
  $('#pwWrap').classList.remove('hidden');
  $('#pwErr').textContent = '';
  const try_ = async () => {
    const pw = $('#docPassword').value;
    status('Descifrando…');
    try {
      await loadPdf(buf, pw);
      $('#pwWrap').classList.add('hidden');
      showWorkspace();
    } catch (e) {
      $('#pwErr').textContent = isPasswordError(e) ? 'Contraseña incorrecta' : e.message;
    }
  };
  $('#pwOpen').onclick = try_;
  $('#docPassword').onkeydown = e => { if (e.key === 'Enter') try_(); };
  $('#docPassword').focus();
}

function showWorkspace() {
  $('#dropzone').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  $('#docName').textContent = S.fileName;
  const kb = S.originalBytes.byteLength / 1024;
  $('#docMeta').textContent = `${S.jsDoc.numPages} pág. · ${kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb.toFixed(0) + ' KB'}`
    + (S.hasTextLayer ? ' · con texto' : ' · SIN capa de texto (usa OCR)');
  status('Listo');
  mounted.clear();
  resetVolatile();
  mountTab(currentTab);
  if (!S.hasTextLayer) {
    toast('Este PDF no tiene capa de texto: ve a la pestaña OCR para hacerlo buscable y editable.', '');
  } else if (currentTab === 'edit') {
    /* Un PDF con texto ya es editable: se activan las cajas automáticamente
       para que se pueda pulsar cualquier línea y corregirla en su sitio. */
    const chk = $('#showTextBoxes');
    if (chk && !chk.checked) {
      chk.checked = true;
      chk.dispatchEvent(new Event('change', { bubbles: true }));
    }
    toast('Haz clic sobre cualquier línea para corregirla en su sitio · Ctrl+S para guardar el PDF', 'ok');
  }
}

/* ------------------------------------------------------------------ */
/* Guardar                                                             */
/* ------------------------------------------------------------------ */
function wireSave() {
  $('#saveBtn').addEventListener('click', save);
  addEventListener('pdf-dirty', () => { dirty = true; $('#saveBtn').textContent = 'Guardar PDF •'; });
  addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  });
  addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
}

async function save() {
  if (!S.originalBytes) return;
  status('Generando PDF…');
  busy(true, 'Escribiendo el PDF…');
  try {
    // aplicar operaciones de página (rotaciones, borrados, duplicados, orden)
    const bytes = await assemble();
    download(bytes, baseName() + '-editado.pdf');
    reportarEdicion();
    dirty = false;
    $('#saveBtn').textContent = 'Guardar PDF';
  } catch (e) {
    console.error(e);
    toast('Error al guardar: ' + e.message, 'err');
  }
  busy(false, 'Listo');
}

/**
 * Informa de cómo se ha resuelto cada corrección: si se ha podido reescribir
 * la línea dentro del PDF conservando su fuente original, o si ha tenido que
 * recurrir a taparla y escribir encima con una fuente estándar.
 */
function reportarEdicion() {
  let enSitio = 0, sustitucion = 0;
  const fallos = [];
  for (const p of Object.keys(S.editItems)) {
    for (const it of S.editItems[p]) {
      if (it.kind !== 'text') continue;
      if (it._mode === 'in situ') enSitio++;
      else if (it._mode === 'sustitución') sustitucion++;
      if (it._inplaceError) fallos.push(it._inplaceError);
    }
  }
  const total = enSitio + sustitucion;
  if (!total) return;

  if (enSitio === total) {
    toast(`${enSitio} línea(s) corregidas conservando la fuente original del PDF`, 'ok');
  } else if (enSitio === 0) {
    toast(`${sustitucion} línea(s) corregidas con fuente estándar (el PDF no permitió editar en sitio)`, 'err');
    if (fallos[0]) toast('Motivo: ' + fallos[0], 'err');
  } else {
    toast(`${enSitio} línea(s) con la fuente original · ${sustitucion} con fuente estándar`, '');
    if (fallos[0]) toast('Motivo del fallback: ' + fallos[0], '');
  }
}

/* Ensambla el documento final aplicando operaciones de página */
async function assemble() {
  const ops = S.pageOps;
  const order = S.pageOrder;   // opcional, definido al reordenar en miniaturas

  // Si no hay cambios estructurales, se edita el original directamente
  const structural = ops.some(o => o.type === 'delete' || o.type === 'duplicate') || !!order;
  if (!structural) {
    S.originalBytes = await applyOverlay(S.originalBytes);
    return S.originalBytes;
  }

  // Reconstruir: copiar páginas en el orden y estado final
  const src = await PDFLib.PDFDocument.load(S.originalBytes, { ignoreEncryption: true });
  const out = await PDFLib.PDFDocument.create();

  let seq = order ? [...order] : Array.from({ length: src.getPageCount() }, (_, i) => i + 1);
  const deletes = new Set(ops.filter(o => o.type === 'delete').map(o => o.page));
  const dups = ops.filter(o => o.type === 'duplicate').map(o => o.page);

  let finalSeq = [];
  for (const p of seq) {
    if (deletes.has(p)) continue;
    finalSeq.push(p);
    if (dups.includes(p)) finalSeq.push(p);
  }

  // Las rotaciones las aplica writer.applyToDoc sobre el documento final,
  // para que funcionen igual con y sin cambios estructurales.
  const copies = await out.copyPages(src, finalSeq.map(p => p - 1));
  copies.forEach(p => out.addPage(p));

  // remapear índices de página para los overlays (si hubo cambios estructurales)
  if (structural) {
    const map = new Map(); // página original → nueva posición
    finalSeq.forEach((orig, i) => map.set(orig, i + 1));
    remapState(map);
  }

  const bytes = await out.save({ useObjectStreams: true });
  const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
  return await drawOnto(doc);
}

/* Aplica overlays sobre el doc en memoria, sin reconstruir páginas */
async function applyOverlay(inputBytes) {
  const prev = S.originalBytes;
  S.originalBytes = inputBytes;
  try {
    const bytes = await build();
    return bytes;
  } finally {
    S.originalBytes = prev;
  }
}

/* Dibuja overlays sobre un doc ya ensamblado */
async function drawOnto(doc) {
  // reutiliza el pipeline de writer sobre el doc dado
  const { applyToDoc } = await import('./writer.js');
  return await applyToDoc(doc);
}

/* Reasigna los overlays a las nuevas páginas tras reordenar */
function remapState(map) {
  for (const key of Object.keys(S.editItems)) {
    const p = +key;
    const n = map.get(p);
    if (n) S.editItems[n] = S.editItems[key];
    delete S.editItems[key];
  }
  for (const key of Object.keys(S.ocrBoxes)) {
    const p = +key;
    const n = map.get(p);
    if (n) S.ocrBoxes[n] = S.ocrBoxes[key];
    delete S.ocrBoxes[key];
  }
  for (const key of Object.keys(S.annots)) {
    const p = +key;
    const n = map.get(p);
    if (n) S.annots[n] = S.annots[key];
    delete S.annots[key];
  }
  S.formFields.forEach(f => { const n = map.get(f.page); if (n) f.page = n; });
  for (const key of Object.keys(S.inkImages)) {
    const p = +key; const n = map.get(p);
    if (n) { S.inkImages[n] = S.inkImages[key]; if (S.signPlaced && S.signPlaced[p]) S.signPlaced[n] = S.signPlaced[p]; }
    delete S.inkImages[key];
  }
}