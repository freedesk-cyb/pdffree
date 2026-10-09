/* ============================================================
   edit.js — Herramientas de edición: texto, tapado, borrado,
   censura e imágenes. Monta las páginas y gestiona el overlay.
   ============================================================ */
import { S, $, $$, pageSize, getTextBoxes, toast, status, busy,
  buildPreviewBytes, renderPreviewPage, clearPreview } from './core.js';
import { Layer, pageCell } from './layer.js';
import { actualizarPanelCambios, onListaCambia, onQuitar } from './cambios.js';

/* Las 14 fuentes estándar: al elegir una se usa su variante real, no una
   aproximación con doble trazado. */
const STANDARD = [
  ['Helvetica', 'Helvetica (Arial)'], ['Helvetica-Bold', 'Helvetica negrita'],
  ['Helvetica-Oblique', 'Helvetica cursiva'], ['Helvetica-BoldOblique', 'Helvetica negrita cursiva'],
  ['Times-Roman', 'Times New Roman'], ['Times-Bold', 'Times New Roman negrita'],
  ['Times-Italic', 'Times New Roman cursiva'], ['Times-BoldItalic', 'Times cursiva negrita'],
  ['Courier', 'Courier New'], ['Courier-Bold', 'Courier negrita'],
  ['Courier-Oblique', 'Courier cursiva'], ['Courier-BoldOblique', 'Courier negrita cursiva'],
  ['Symbol', 'Symbol'], ['ZapfDingbats', 'ZapfDingbats'],
];
let layers = new Map();
let tool = 'select';
let pendingImage = null;

export function initEdit() {
  actualizarPanelCambios();
  const sel = $('#fFont');
  STANDARD.forEach(([val, label]) => {
    const o = document.createElement('option');
    o.value = val; o.textContent = label;
    sel.appendChild(o);
  });
  const custom = document.createElement('option');
  custom.value = '__custom';
  custom.textContent = '+ cargar fuente TTF…';
  sel.appendChild(custom);
  sel.addEventListener('change', () => {
    if (sel.value === '__custom') {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.ttf,.otf';
      inp.onchange = async () => {
        const f = inp.files[0];
        if (!f) { sel.selectedIndex = 0; return; }
        try { await loadFontkit(); } catch { /* seguimos sin fontkit */ }
        const bytes = new Uint8Array(await f.arrayBuffer());
        S.customFonts = S.customFonts || {};
        S.customFonts[f.name] = { bytes, name: f.name.replace(/\.(ttf|otf)$/i, '') };
        const o = document.createElement('option');
        o.value = 'custom:' + f.name; o.textContent = f.name;
        sel.appendChild(o); sel.value = o.value;
        toast('Fuente cargada: ' + f.name, 'ok');
      };
      inp.click();
    }
  });

  $$('.tool[data-tool]').forEach(b => b.addEventListener('click', () => {
    tool = b.dataset.tool;
    $$('.tool[data-tool]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    if (tool === 'image') pickImage();
    updateCursor();
  }));

  $('#coverColor').addEventListener('input', e => { $('#coverLbl').textContent = 'tapado ' + e.target.value; });

  $('#bBold').addEventListener('click', () => $('#bBold').classList.toggle('active'));
  $('#bItalic').addEventListener('click', () => $('#bItalic').classList.toggle('active'));
  $$('[data-align]').forEach(b => b.addEventListener('click', () => {
    $$('[data-align]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const l = layers.values().next().value;
    if (l && l.selected && l.selected.kind === 'text') {
      l.selected.style = { ...(l.selected.style || {}), align: b.dataset.align };
      l.renderItem(l.selected);
      l.select(l.selected);
      markDirty();
    }
  }));

  $('#showTextBoxes').addEventListener('change', e => { drawTextBoxes(e.target.checked); });

  /* La barra de formato se aplica al elemento de texto seleccionado. */
  const restyle = () => {
    const l = layers.values().next().value;
    const it = l && l.selected;
    if (!it || it.kind !== 'text') return;
    it.style = { ...(it.style || {}), ...currentStyle() };
    l.renderItem(it);
    l.select(it);
    markDirty();
  };
  $('#fFont').addEventListener('change', restyle);
  $('#fSize').addEventListener('change', restyle);
  $('#fColor').addEventListener('input', restyle);
  $('#bBold').addEventListener('click', restyle);
  $('#bItalic').addEventListener('click', restyle);

  $('#delSel').addEventListener('click', () => {
    for (const l of layers.values()) if (l.selected) { l.remove(l.selected); break; }
  });
  $('#clearAll').addEventListener('click', () => {
    if (!confirm('¿Quitar todos los cambios de edición de todas las páginas?')) return;
    S.editItems = {};
    clearPreview();
    mountEdit();
    actualizarPanelCambios();
    toast('Cambios de edición descartados');
  });
  $('#undoBtn').addEventListener('click', () => {
    const it = lastRemoved;
    if (it) {
      const arr = S.editItems[it.__page] || (S.editItems[it.__page] = []);
      arr.push(it);
      mountEdit();
      toast('Elemento restaurado');
    } else toast('Nada que deshacer todavía');
  });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); $('#undoBtn').click(); }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const t = e.target.tagName;
      if (t === 'TEXTAREA' || t === 'INPUT') return;
      $('#delSel').click();
    }
  });
}

let lastRemoved = null;

function currentStyle() {
  return {
    font: $('#fFont').value === '__custom' ? 'Helvetica' : $('#fFont').value,
    size: +$('#fSize').value,
    color: $('#fColor').value,
    bold: $('#bBold').classList.contains('active'),
    italic: $('#bItalic').classList.contains('active'),
    align: ($('[data-align].active') || {}).dataset?.align || 'left',
  };
}

function updateCursor() { /* el cursor se fija en Layer al construir */ }

function pickImage() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onload = () => {
    const f = inp.files[0];
    const fr = new FileReader();
    fr.onload = () => {
      pendingImage = fr.result;
      toast('Imagen cargada. Arrástrala en la página donde quieras colocarla.', 'ok');
      tool = 'image';
    };
    fr.readAsDataURL(f);
  };
  inp.click();
}

/* Texto bajo una zona (para "pegar la corrección"): convierte px→unidades PDF */
async function textUnder(pageNum, box) {
  try {
    const s = box.pscale || 1.35;
    const r = { x: box.x / s, y: box.y / s, w: (box.w || 0) / s, h: (box.h || 0) / s };
    const boxes = await getTextBoxes(pageNum);
    const hits = boxes.filter(b =>
      b.x + b.w > r.x - 2 && b.x < r.x + r.w + 2 &&
      b.y + b.h > r.y - 2 && b.y < r.y + r.h + 2);
    return hits.map(h => h.str).join(' ');
  } catch { return ''; }
}

async function mountEditInternal() {
  previewFonts = null;              // al abrir otro PDF cambian sus fuentes
  const cont = $('#pages-edit');
  if (!S.jsDoc) return;
  cont.innerHTML = '';
  layers = new Map();
  busy(true, 'Preparando páginas…');

  const n = S.jsDoc.numPages;
  const step = n > 40 ? 2 : 1;
  for (let p = 1; p <= n; p += step) {
    const cell = pageCell(p, cont);
    const items = S.editItems[p] || (S.editItems[p] = []);
    for (const it of items) it.pscale = 1.35;

    const l = new Layer(p, cell, items, {
      scale: 1.35,
      get tool() { return tool; },
      get coverColor() { return $('#coverColor').value; },
      get pendingImage() { return pendingImage; },
      get textStyle() { return currentStyle(); },
      onChange(it) {
        it.__page = p;
        if (it.kind === 'cover' || it.kind === 'whiteout' || it.kind === 'redact') {
          textUnder(p, it).then(txt => {
            if (txt) {
              try { navigator.clipboard.writeText(txt); toast('Texto tapado copiado al portapapeles: "' + txt + '"', 'ok'); }
              catch { toast('Texto bajo la zona: "' + txt + '"'); }
            }
          });
        }
        markDirty();
        /* si el elemento ya está en el PDF de fondo, deja de estar "aplicado" */
        it.applied = false;
        it.oculto = false;
        actualizarPanelCambios();
      },
      onItemAdd() { clearTimeout(refrescoTimer); refrescoPendiente.clear(); },
    });
    layers.set(p, l);
  }
  if (step > 1) toast(`Mostrando 1 de cada ${step} páginas por rendimiento (guarda igualmente todas).`);
  drawTextBoxes($('#showTextBoxes').checked);
  markDirty();
  busy(false, 'Listo para editar');
}

/* Cajas de texto detectadas. Al hacer clic sobre una se abre el editor
   justo encima del texto: se escribe allí mismo, con su tamaño y su
   fuente, y el cambio se ve mientras se teclea. */
async function drawTextBoxes(show) {
  for (const [, l] of layers) l.layer.querySelectorAll('.tbox').forEach(n => n.remove());
  if (!show) return;
  status('Detectando texto…');
  const sc = 1.35;

  /* Se sacan del PDF sus propias fuentes para poder previsualizar el
     texto con la tipografía exacta del documento. */
  status('Cargando fuentes del documento…');
  const fuentes = await loadPreviewFonts();

  for (const [p, l] of layers) {
    const boxes = await getTextBoxes(p);
    for (const b of boxes) {
      b.pdfFont = buscarFuente(b.realName);
      /* Cada bloque por separado: un título a la izquierda y una fecha a
         la derecha son dos cajas distintas, no una fila gigante. */
      const targets = b.blocks?.length ? b.blocks : [b];
      for (const t of targets) {
        const d = document.createElement('div');
        d.className = 'tbox';
        d.title = t.str;
        d.style.cssText = `position:absolute;left:${t.x * sc}px;top:${t.y * sc}px;`
          + `width:${t.w * sc}px;height:${Math.max(t.h, 6) * sc}px;border:1px solid #2f81f755;`
          + `cursor:text;background:#2f81f70d;overflow:visible;`;
        d.addEventListener('click', ev => { ev.stopPropagation(); abrirEditor(l, p, b, t, sc); });
        l.layer.appendChild(d);
      }
    }
  }
  status('Haz clic sobre una línea para corregirla');
}

function buscarFuente(nombreReal) {
  if (!nombreReal || !previewFonts) return null;
  const { css } = previewFonts;
  if (css.has(nombreReal)) return css.get(nombreReal);
  const norm = String(nombreReal).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  for (const [k, v] of css) {
    const nk = k.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (nk === norm || (nk && (norm.includes(nk) || nk.includes(norm)))) return v;
  }
  return null;
}

/* Extrae las fuentes incrustadas de las páginas visibles (una sola vez) */
let previewFonts = null;
async function loadPreviewFonts() {
  if (previewFonts) return previewFonts;
  previewFonts = { css: new Map(), base: new Map() };
  if (!S.jsDoc) return previewFonts;
  try {
    const { registerPageFonts } = await import('./preview-fonts.js');
    const doc = S.outDoc;
    if (!doc) return previewFonts;
    const max = Math.min(doc.getPageCount(), 6);
    for (let i = 0; i < max; i++) {
      const m = await registerPageFonts(doc, i);
      for (const [k, v] of m.css) previewFonts.css.set(k, v);
      for (const [k, v] of m.base) previewFonts.base.set(k, v);
    }
    status(`Fuentes del documento: ${previewFonts.css.size}`);
  } catch (e) {
    console.warn('No se pudieron previsualizar las fuentes:', e.message);
  }
  return previewFonts;
}

/* ------------------------------------------------------------------ */
/* Editor en línea                                                     */
/* ------------------------------------------------------------------ */

/**
 * Abre un cuadro de escritura encima del fragmento elegido, con el texto
 * original ya dentro y el cursor al final. Se escribe directamente allí:
 * no hay diálogos, se ve lo que se cambia y se puede seguir editando.
 */
function abrirEditor(l, page, box, target, sc) {
  const lay = layers.get(page) || l;
  lay.select(null);
  lay.layer.querySelectorAll('.tbox.editing').forEach(n => n.classList.remove('editing'));

  /* Si esa línea ya estaba corregida, se retira la corrección anterior:
     al abrirla otra vez no pueden quedar dos textos superpuestos. */
  quitarCorreccionPrevia(lay, {
    x: target.x, y: target.y, baseline: box.baseline,
  });

  const item = {
    kind: 'text',
    x: target.x * sc, y: target.y * sc,
    w: Math.max(target.w * sc, 30), h: Math.max(target.h * sc, 12),
    pscale: sc,
    baseline: true,                 // el borde inferior es la línea base
    editing: true,
    text: target.str,
    /* datos para reescribir el PDF conservando la fuente incrustada */
    inplace: true,
    original: target.str,
    originalBox: { x: target.x, y: target.y, w: target.w, h: target.h, baseline: box.baseline },
    coverColor: $('#coverColor').value,
    coverPad: 0,
    style: {
      family: box.family,
      size: target.size || box.fontSize,
      color: $('#fColor').value,
      align: 'left',
      pdfFont: box.pdfFont || null,   // fuente incrustada, para previsualizar
      probe: { text: target.str, width: target.w },
    },
  };

  lay.add(item, true);
  const node = lay.layer.querySelector(`.item[data-id="${item.id}"]`);
  const ta = node?._ta;
  if (!ta) return;
  /* el estado va en data-editing para ganar especificidad en CSS */
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  ta.addEventListener('input', () => {
    /* Si había un fragmento seleccionado, lo que se ha escrito encima es el
       texto nuevo; el resto de la línea se conserva tal cual en el PDF. */
    if (fragmento) {
      const cola = fragmento.antes.length - fragmento.fin;
      const largo = Math.max(0, ta.value.length - cola);
      item.fragment = { find: fragmento.find, replace: ta.value.slice(fragmento.ini, largo) };
    }
    /* la caja crece hacia la derecha para que quepa lo que se escribe */
    const w = Math.min(ta.scrollWidth + 10, 1200);
    if (w > item.w) { item.w = w; node.style.width = w + 'px'; }
  });
  /* Si el usuario selecciona solo una parte del texto y escribe encima,
     se edita únicamente ese fragmento: el resto de la frase conserva
     sus propios glifos dentro del PDF. */
  let fragmento = null;
  const capturarFragmento = () => {
    if (fragmento) return;
    const ini = ta.selectionStart, fin = ta.selectionEnd;
    if (ini == null || fin == null || ini === fin) return;
    const trozo = ta.value.slice(ini, fin);
    if (!trozo.trim()) return;
    fragmento = { ini, fin, antes: ta.value, find: trozo };
    item.original = trozo;
    status('Se sustituye solo: «' + trozo + '»');
  };

  ta.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (!ev.ctrlKey && !ev.metaKey) capturarFragmento();
    if (ev.key === 'Escape') { ev.preventDefault(); cancelarEditor(lay, item); }
    else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); confirmarEditor(lay, item); }
  });
  ta.addEventListener('paste', capturarFragmento);
  ta.addEventListener('beforeinput', () => {
    if (!fragmento) {
      const ini = ta.selectionStart, fin = ta.selectionEnd;
      if (ini != null && ini !== fin) capturarFragmento();
    }
  });
  ta.addEventListener('blur', () => { if (item.editing) confirmarEditor(lay, item); });
}

function confirmarEditor(l, item) {
  item.editing = false;
  const node = l.layer.querySelector(`.item[data-id="${item.id}"]`);
  if (node) node.dataset.editing = '0';
  if (!item.text.trim()) { l.remove(item); return; }
  markDirty();
  avisarFaltantes(item);
  status('Corregido. Puedes seguir editando o pulsar Ctrl+S para guardar.');
  refrescarEnVivo(l, item.__page);
}

/**
 * Vuelve a pintar la página con el PDF ya editado. Así el cambio se ve en el
 * documento real, en su sitio y con su tipografía, sin esperar a guardar.
 * Se hace con un retardo corto para no rehacerlo en cada pulsación y solo
 * mientras la persona sigue escribiendo en el documento.
 */
let refrescoTimer = null;
let refrescoPendiente = new Set();

function refrescarEnVivo(l, pageNum) {
  if (!pageNum) return;
  refrescoPendiente.add(pageNum);
  clearTimeout(refrescoTimer);
  refrescoTimer = setTimeout(() => { ejecutarRefresco(); }, 700);
}

async function ejecutarRefresco() {
  if (refrescoEjecutando) return;
  refrescoEjecutando = true;
  const paginas = [...refrescoPendiente];
  refrescoPendiente.clear();
  const previo = status('');
  try {
    status('Actualizando la vista…');
    await buildPreviewBytes();

    for (const p of paginas) {
      const lay = layers.get(p);
      if (!lay) continue;
      const canvas = lay.layer.parentElement?.querySelector('canvas')
        || document.querySelector(`#pages-edit .page[data-page="${p}"] canvas`);
      if (!canvas) continue;

      /* el PDF de fondo ya lleva estos cambios: se ocultan en la capa
         para no ver el texto dos veces */
      for (const it of lay.items) if (it.kind === 'text') { it.applied = true; it.oculto = true; }
      lay.renderItems();

      await renderPreviewPage(p, canvas, lay.scale || 1.35);
    }
    actualizarPanelCambios();
  } catch (e) {
    console.warn('vista previa:', e);
    status(previo);
  } finally {
    refrescoEjecutando = false;
    status('Listo. Puedes seguir editando o pulsar Ctrl+S para guardar.');
  }
}
let refrescoEjecutando = false;

/** Al deshacer un cambio de la lista, se quita y se repinta esa página. */
onQuitar((pagina, it) => {
  const lay = layers.get(pagina);
  if (lay) lay.remove(it);
  const arr = S.editItems[pagina];
  if (arr) { const i = arr.indexOf(it); if (i >= 0) arr.splice(i, 1); }
  clearPreview();
  clearTimeout(refrescoTimer);
  refrescoPendiente.clear();
  refrescoPendiente.add(pagina);
  ejecutarRefresco();
});

/** Cuando la lista pide repintar, se repinta. */
onListaCambia(() => { /* la lista se actualiza sola tras cada cambio */ });

/** Los elementos ya volcados en el PDF de fondo dejan de dibujarse encima. */
function marcarAplicados() { /* se hace dentro de ejecutarRefresco */ }

/**
 * Las fuentes incrustadas en un PDF suelen traer solo los glifos que usaba
 * el documento. Si se escribe una letra que no estaba, esa letra no se puede
 * dibujar con la tipografía original: se avisa en el momento, no al guardar.
 */
function avisarFaltantes(item) {
  const fam = item.pdfCssFont;
  const texto = item.text || '';
  if (!fam || !texto.trim() || !document.fonts) return;
  if (document.fonts.check(`12px "${fam}"`, texto)) return;

  const faltan = [...new Set([...texto].filter(c => !document.fonts.check(`12px "${fam}"`, c)))];
  const lista = faltan.slice(0, 12).join(' ');
  toast(`La fuente del PDF no tiene ${faltan.length === 1 ? 'la letra' : 'estas letras'}: ${lista}`
    + `${faltan.length > 12 ? '…' : ''}. Se guardará con una fuente estándar en ese trozo.`, '');
}

function cancelarEditor(l, item) {
  const node = l.layer.querySelector(`.item[data-id="${item.id}"]`);
  if (node) node.dataset.editing = '0';
  l.remove(item);
  status('Edición cancelada');
}

/**
 * Si esa línea ya tenía una corrección, se quita la anterior: corregir dos
 * veces la misma línea NO debe dejar dos textos encima, sino que el último
 * prevalece. Sin esto, la línea quedaba duplicada en el PDF.
 */
function quitarCorreccionPrevia(l, b) {
  const mismos = l.items.filter(it => it.kind === 'text' && (
    (it.originalBox && (
      (Math.abs(it.originalBox.x - b.x) < 10 && Math.abs(it.originalBox.y - b.y) < 10) ||
      (it.originalBox.baseline != null && b.baseline != null && Math.abs(it.originalBox.baseline - b.baseline) < 10)
    )) ||
    (it.original && b.str && (it.original === b.str || it.original.includes(b.str) || b.str.includes(it.original)))
  ));
  for (const it of mismos) l.remove(it);
  if (mismos.length) actualizarPanelCambios();
  return mismos.length;
}

/**
 * Sustituye una línea completa conservando formato y posición.
 * Se marca el elemento como «in situ»: al guardar, el motor reescribe la
 * línea DENTRO del flujo de contenido usando la fuente incrustada. Si no
 * puede, cae al método de tapado y escribir encima.
 */
function replaceLine(l, page, b, value, sc) {
  quitarCorreccionPrevia(l, b);
  l.add({
    kind: 'text',
    x: b.x * sc, y: b.y * sc, w: Math.max(b.w * sc, 40), h: b.h * sc,
    pscale: sc,
    baseline: true,
    inplace: true,
    original: b.str,
    originalBox: { x: b.x, y: b.y, w: b.w, h: b.h, baseline: b.baseline },
    coverColor: $('#coverColor').value,
    coverPad: 2,
    text: value,
    pdfCssFont: b.pdfFont || null,
    style: {
      family: b.family,
      size: b.fontSize,
      color: $('#fColor').value,
      align: 'left',
      pdfFont: b.pdfFont || null,
      probe: { text: b.str, width: b.w },
    },
  }, false);
  markDirty();
}

function markDirty() { window.dispatchEvent(new CustomEvent('pdf-dirty')); }

/* API pública para otros módulos */
export function mountEdit() { return mountEditInternal(); }
export function getEditLayers() { return layers; }
export function setTool(t) { tool = t; }
export function setPendingImage(d) { pendingImage = d; }