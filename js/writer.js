/* ============================================================
   writer.js — Convierte el estado del editor en un PDF real.

   Clave del diseño: los rectángulos de tapado/borrado se pintan
   SOBRE el contenido original y encima se dibuja el texto
   corregido. El texto viejo, aunque siga en el archivo, queda
   ilegible e incunable; para censura real (redact) se rasteriza
   la zona, que sí elimina los glifos de forma permanente.
   ============================================================ */
import { S, pageSize, baseName, download } from './core.js';

const PL = PDFLib;   // cantoo/pdf-lib (superconjunto de pdf-lib, con AES-256)

/* ------------------------------------------------------------------ */
/* Fuentes                                                              */
/* ------------------------------------------------------------------ */
/* Las 14 fuentes estándar del PDF. Son las únicas que se pueden usar sin
   incrustar un TTF; con cualquier otra fuente el resultado es una aproximación. */
const STANDARD = {
  Courier: 'Courier', 'Courier-Bold': 'CourierBold', 'Courier-Oblique': 'CourierOblique',
  'Courier-BoldOblique': 'CourierBoldOblique',
  Helvetica: 'Helvetica', 'Helvetica-Bold': 'HelveticaBold', 'Helvetica-Oblique': 'HelveticaOblique',
  'Helvetica-BoldOblique': 'HelveticaBoldOblique',
  'Times-Roman': 'TimesRoman', 'Times-Bold': 'TimesRomanBold', 'Times-Italic': 'TimesRomanItalic',
  'Times-BoldItalic': 'TimesRomanBoldItalic',
  Symbol: 'Symbol', 'ZapfDingbats': 'ZapfDingbats',
};

/** Nombres de familia → juego de candidatos, del más probable al menos. */
const FAMILIES = {
  'serif': ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  'times': ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'],
  'sans-serif': ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  arial: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'],
  monospace: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
  courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'],
  symbol: ['Symbol'],
  'zapfdingbats': ['ZapfDingbats'],
  zapfdingbats: ['ZapfDingbats'],
};

const fontCache = new Map();   // nombre → {doc, font}
const fontkitRegistered = new WeakSet();

async function embedStandard(doc, key) {
  if (fontCache.get(key)?.doc === doc) return fontCache.get(key).font;
  const font = await doc.embedFont(PL.StandardFonts[key] || PL.StandardFonts.Helvetica);
  fontCache.set(key, { doc, font });
  return font;
}

export async function getFont(doc, name) {
  const key = name || 'Helvetica';
  if (fontCache.get(key)?.doc === doc) return fontCache.get(key).font;
  if (key.startsWith('custom:')) {
    const data = S.customFonts && S.customFonts[key.slice(7)];
    if (!data) return embedStandard(doc, 'Helvetica');
    if (window.fontkit && !fontkitRegistered.has(doc)) {
      doc.registerFontkit(window.fontkit);
      fontkitRegistered.add(doc);
    }
    /* Sin subconjunto: el codificador Brotli del motor de fuentes que
       usamos en el navegador falla y rompería la incrustación. El
       archivo pesa algo más, pero el texto sale idéntico. */
    const font = await doc.embedFont(data.bytes, { subset: false });
    fontCache.set(key, { doc, font });
    return font;
  }
  return embedStandard(doc, STANDARD[key] || 'Helvetica');
}
export function resetFontCache() { fontCache.clear(); }

/**
 * Elige la fuente estándar que mejor reproduce el texto original y calcula
 * el escalado horizontal necesario para que mida exactamente lo mismo.
 *
 * Sin esto, un PDF con una fuente condensada se vería al sustituir una línea
 * con otra más ancha: el texto se descuadraría respecto al diseño.
 */
export async function pickFont(doc, style) {
  // 1. candidatos según la familia detectada (o la elegida en la barra)
  let cands;
  const fam = String(style.family || '').toLowerCase();
  if (fam && FAMILIES[fam]) cands = FAMILIES[fam].slice();
  else if (STANDARD[style.font]) cands = [STANDARD[style.font]];
  else cands = FAMILIES['sans-serif'].slice();

  // 2. si el usuario pidió negrita/cursiva a mano, priorizamos esa variante
  if (!style.probe) {
    const wanted = variantKey(cands, !!style.bold, !!style.italic);
    if (wanted) cands = [wanted, ...cands.filter(k => k !== wanted)];
  }

  // 3. con texto de referencia, medimos cuál de las 14 encaja
  const probe = style.probe;
  const size = style.size || 12;
  let best = null;
  for (const key of cands) {
    const font = await embedStandard(doc, key);
    if (!probe || !probe.text || !probe.width) {
      if (!best) best = { key, font, score: Infinity, hScale: 1 };
      continue;
    }
    const natural = font.widthOfTextAtSize(probe.text, size);
    if (!natural) continue;
    const score = Math.abs(natural - probe.width) / probe.width;
    if (!best || score < best.score) {
      best = { key, font, score, hScale: probe.width / natural };
    }
  }
  if (!best) best = { key: 'Helvetica', font: await embedStandard(doc, 'Helvetica'), score: 1, hScale: 1 };

  // 4. Anchura. Una fuente condensada (tipo Helvetica Narrow) hace que TODAS
  //    las candidatas midan más de lo que mide la línea real, así que el error
  //    absoluto es grande pero la candidata correcta sigue siendo la mejor:
  //    condensar multiplica todos los anchos por el mismo factor, de modo que
  //    el mínimo se conserva. Se aplica el factor mientras siga siendo razonable.
  let hScale = 1;
  if (probe?.width && best.hScale > 0.3 && best.hScale < 1.5) {
    hScale = best.hScale;
  }
  return { font: best.font, key: best.key, hScale, score: best.score };
}

/** Devuelve la clave de la variante negrita/cursiva dentro de una familia. */
function variantKey(cands, bold, italic) {
  if (!bold && !italic) return null;
  const italicSuffix = cands.some(k => k.endsWith('Italic')) ? 'Italic' : 'Oblique';
  const suffix = (bold ? 'Bold' : '') + (italic ? italicSuffix : '');
  return cands.find(k => k.endsWith(suffix)) || null;
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

function toRgb(hex, fallback = { r: 0, g: 0, b: 0 }) {
  if (!hex) return fallback;
  let h = String(hex).replace('#', '').trim();
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return fallback;
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

/** Ajuste de línea por medición real de la fuente */
export function wrapText(font, text, size, maxWidth) {
  if (!maxWidth || maxWidth <= 1) return String(text).split('\n');
  const out = [];
  for (const para of String(text).split('\n')) {
    const tokens = para.split(/(\s+)/).filter(t => t !== '');
    let line = '';
    for (const t of tokens) {
      const test = line + t;
      if (line && font.widthOfTextAtSize(test, size) > maxWidth) {
        out.push(line.replace(/\s+$/, ''));
        line = /^\s+$/.test(t) ? '' : t;
      } else line = test;
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

/**
 * Caja en píxeles de pantalla → caja PDF (origen abajo-izq.).
 * Usa la altura real de la página del pdf-lib: así el resultado no depende
 * de que pdf.js esté cargado ni de la escala a la que se vio la página.
 */
export function screenToPdfBox(it, pageH) {
  const s = it.pscale || 1.35;
  return {
    x: it.x / s,
    y: pageH - (it.y + (it.h || 0)) / s,
    w: (it.w || 0) / s,
    h: (it.h || 0) / s,
  };
}

/* ------------------------------------------------------------------ */
/* Dibujado de cada tipo de contenido                                   */
/* ------------------------------------------------------------------ */

/** Capa de texto invisible: hace el PDF buscable y seleccionable */
function drawInvisibleLayer(page, boxes, font) {
  if (!boxes?.length) return;
  const pageH = page.getHeight();
  for (const box of boxes) {
    if (!box.text || !box.text.trim()) continue;
    const size = Math.max(box.h * 0.78, 5);
    let top = box.y;                                  // coords pdf.js: origen arriba
    for (const ln of wrapText(font, box.text, size, box.w)) {
      if (ln.trim()) {
        page.drawText(ln, {
          x: box.x, y: pageH - (top + size * 0.82),
          size, font, opacity: 0, color: PL.rgb(0, 0, 0),
        });
      }
      top += size * 1.2;
    }
  }
}

/** Tapado / borrado / censura */
function drawCover(page, it) {
  const p = screenToPdfBox(it, page.getHeight());
  const c = it.kind === 'redact'
    ? { r: 0, g: 0, b: 0 }
    : toRgb(it.color || '#ffffff', { r: 1, g: 1, b: 1 });
  page.drawRectangle({
    x: p.x, y: p.y,
    width: Math.max(p.w, 0.1), height: Math.max(p.h, 0.1),
    color: PL.rgb(c.r, c.g, c.b),
  });
}

/**
 * Texto editado conservando el formato y la posición del original.
 *
 * Hay dos caminos, y se intenta siempre el primero:
 *
 *  1. EDICIÓN EN SITIO. Se reescribe la línea dentro del flujo de
 *     contenido con la fuente que ya está incrustada en el PDF. Es lo
 *     único que conserva la tipografía real (condensada, negrita,
 *     cursiva, marca) sin aproximaciones. Si el motor no puede, se pasa
 *     al segundo camino automáticamente.
 *
 *  2. SUSTITUCIÓN. Se tapa la línea con un rectángulo del color del
 *     fondo y se escribe el texto nuevo por encima con una de las 14
 *     fuentes estándar, ajustando la anchura con el operador Tz si la
 *     original era condensada.
 */
async function drawText(page, it) {
  if (!it.text || !it.text.trim()) return;

  if (it.inplace && it.originalBox) {
    const done = await tryInPlace(page.doc, page, it);
    if (done) { it._mode = 'in situ'; return; }
  }
  await drawTextOver(page, it);
}

/* ---------------- camino 1: dentro del flujo de contenido ---------------- */
async function tryInPlace(doc, pageObj, it) {
  const { replaceTextInPlace } = await import('./inplace.js');
  const b = it.originalBox;
  const idx = doc.getPages().indexOf(pageObj);
  if (idx < 0) return false;

  /* Si el usuario solo seleccionó un trozo, se sustituye ese trozo:
     el resto de la frase se queda con sus propios glifos. */
  const buscar = it.fragment?.find || it.original;
  const escribir = it.fragment?.replace ?? it.text;

  const res = await replaceTextInPlace(doc, idx, {
    text: buscar,
    x: b.x,
    y: b.baseline,
  }, escribir);

  if (!res.ok) {
    it._inplaceError = res.reason;

    /* La fuente incrustada no trae las letras del texto nuevo. Se BORRA el
       original del flujo de contenido en vez de taparlo con un rectángulo:
       tapado el texto se quedaba debajo, legible y buscable. */
    const { removeTextInPlace } = await import('./inplace.js');
    const borrado = await removeTextInPlace(doc, idx, {
      text: buscar,
      x: b.x,
      y: b.baseline,
    });
    if (borrado.ok) {
      it._originalBorrado = true;
      it._borrado = it._borrado || {};
      it._borrado[buscar] = true;
    } else {
      /* si tampoco se puede borrar, al menos se tapa */
      it._noBorrado = borrado.reason || '';
      drawCover(pageObj, {
        kind: 'cover',
        x: it.x - 2,
        y: it.y - 4,
        w: (it.w || 40) + 8,
        h: (it.h || 12) + 8,
        color: it.coverColor || '#ffffff',
        pscale: it.pscale,
      });
    }
    return false;
  }
  it._fontUsed = res.fontName;
  return true;
}

/* ---------------- camino 2: tapar y escribir encima ---------------- */
async function drawTextOver(page, it) {
  const style = it.style || {};
  const size = style.size || 12;
  const pageH = page.getHeight();
  const p = screenToPdfBox(it, pageH);

  const { font, key, hScale } = await pickFont(page.doc, style);
  const c = toRgb(style.color || '#000000');
  const color = PL.rgb(c.r, c.g, c.b);

  /* El ancho de ajuste se corrige con el escalado: si el texto se estrecha
     un 30%, cabe un 30% más de caracteres por línea que lo que mide la
     fuente sin transformar. Sin esta división el texto se parte antes de
     tiempo y salta de línea sin razón. */
  /* Al corregir una línea existente, el texto nuevo puede ocupar el espacio
     que hay a su derecha: si no, se partiría en varias líneas y el documento
     crecería, que es justo lo que no quiere quien corrige un dato. Solo se
     parte si de verdad no cabe en el ancho de la página. */
  const margenDerecho = 8;
  const disponible = it.inplace
    ? Math.max(p.w, page.getWidth() - p.x - margenDerecho)
    : p.w;
  const normText = (it.text || '').replace(/[\u25CF\u25CB\u2023\u25E6\uF0B7\u25FE\u25AA\u25AB]/g, '\u2022');
  const lines = wrapText(font, normText, size, disponible / hScale);
  const lineH = size * (style.lineHeight || 1.18);

  /* La primera línea se ancla en la base; las siguientes suben.
     `baseline: true` = el borde inferior del recuadro ES la línea base. */
  let y = it.baseline ? p.y : p.y + size * 0.2;

  const scaled = Math.abs(hScale - 1) > 0.005;
  if (scaled) page.pushOperators(tzOperator(hScale * 100));

  for (const ln of lines) {
    if (ln) {
      const wLine = font.widthOfTextAtSize(ln, size) * hScale;
      let x = p.x;
      if (style.align === 'center') x = p.x + (p.w - wLine) / 2;
      else if (style.align === 'right') x = p.x + p.w - wLine;
      page.drawText(ln, { x, y, size, font, color });
    }
    y += lineH;
  }

  if (scaled) page.pushOperators(tzOperator(100));
  it._mode = 'sustitución';
  it._resolvedFont = key;
}

/** Operador PDF «Tz»: escala horizontal del texto, en porcentaje. */
function tzOperator(percent) {
  return PL.PDFOperator.of('Tz', [String(round2(percent))]);
}
function round2(n) { return Math.round(n * 100) / 100; }

/** Imagen insertada o reemplazada */
async function drawImage(page, it) {
  if (!it.src) return;
  let img;
  try {
    if (it.src.startsWith('data:image/jpeg') || it.src.startsWith('data:image/jpg')) img = await page.doc.embedJpg(it.src);
    else img = await page.doc.embedPng(it.src);
  } catch { return; }
  const p = screenToPdfBox(it, page.getHeight());
  page.drawImage(img, { x: p.x, y: p.y, width: Math.max(p.w, 1), height: Math.max(p.h, 1) });
}

/** Firma manuscrita */
async function drawSignature(doc, page, pNum) {
  const dataUrl = S.inkImages[pNum];
  if (!dataUrl) return;
  const img = await doc.embedPng(dataUrl);
  const rect = S.signPlaced && S.signPlaced[pNum];
  const pageW = page.getSize().width;
  if (rect) {
    const p = screenToPdfBox(rect, page.getHeight());
    page.drawImage(img, { x: p.x, y: p.y, width: Math.max(p.w, 1), height: Math.max(p.h, 1) });
  } else {
    const w = pageW * 0.28;
    const h = w * (img.height / img.width);
    page.drawImage(img, { x: pageW - w - 36, y: 36, width: w, height: h });
  }
}

/** Campos de formulario AcroForm */
async function drawForms(doc, pages) {
  if (!S.formFields.length) return;
  const form = doc.getForm();
  let created = 0;
  for (const f of S.formFields) {
    if (f.existing) {
      // el campo ya existe en el PDF: solo actualizamos su valor
      try {
        const real = form.getFieldMaybe(f.name);
        if (!real) continue;
        if (f.type === 'checkbox') { f.checked ? real.check() : real.uncheck(); }
        else if (f.value != null && f.value !== '') real.setText(String(f.value));
      } catch { /* campo no editable */ }
      continue;
    }
    const page = pages[f.page - 1];
    if (!page) continue;
    const { height, width } = page.getSize();
    const s = f.pscale || 1.35;
    const x = Math.min(Math.max(f.x / s, 0), width - 8);
    const y = Math.min(Math.max(height - (f.y + f.h) / s, 0), height - 8);
    const w = Math.min(Math.max(f.w / s, 8), width - x);
    const h = Math.min(Math.max(f.h / s, 8), height - y);

    if (f.type === 'text') {
      const tf = form.createTextField(f.name);
      tf.addToPage(page, { x, y, width: w, height: h, borderWidth: 1 });
      if (f.multiline) tf.enableMultiline();
      if (f.value) tf.setText(String(f.value));
      created++;
    } else if (f.type === 'checkbox') {
      const cb = form.createCheckBox(f.name);
      cb.addToPage(page, { x, y, width: Math.min(w, h), height: Math.min(w, h) });
      if (f.checked) cb.check();
      created++;
    } else if (f.type === 'dropdown') {
      const dd = form.createDropdown(f.name);
      dd.addToPage(page, { x, y, width: w, height: h });
      const opts = f.options && f.options.length ? f.options : ['Sí', 'No'];
      dd.setOptions(opts);
      if (f.value && opts.includes(f.value)) dd.select(f.value);
      else dd.select(opts[0]);
      created++;
    } else if (f.type === 'radio') {
      const rg = form.createRadioGroup(f.name);
      const size = Math.min(w, h);
      const opts = f.options && f.options.length ? f.options : ['A', 'B'];
      opts.forEach((label, i) => {
        rg.addOptionToPage(page, `${f.name}_${i}`, {
          x: x + i * (size + 6), y, width: size, height: size,
        });
      });
      if (f.checked) rg.select(`${f.name}_0`);
      created++;
    }
  }
  try { form.updateFieldAppearances(); } catch { }
  return created;
}

/** Anotaciones: resaltado, tachado, subrayado, dibujo, comentario */
function drawAnns(page, pNum) {
  const list = S.annots[pNum];
  if (!list?.length) return;
  const pageH = page.getHeight();
  const pageW = page.getSize().width;
  for (const a of list) {
    const s = a.pscale || 1;
    const c = toRgb(a.color || '#ffe14d');
    const rgb = PL.rgb(c.r, c.g, c.b);
    const x1 = clamp(a.x1 / s, 0, pageW), x2 = clamp(a.x2 / s, 0, pageW);
    const y1 = clamp(a.y1 / s, 0, pageH), y2 = clamp(a.y2 / s, 0, pageH);
    const minX = Math.min(x1, x2), maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2), maxY = Math.max(y1, y2);

    switch (a.type) {
      case 'highlight':
        page.drawRectangle({
          x: minX, y: minY, width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
          color: rgb, opacity: 0.35, blendMode: PL.BlendMode.Multiply,
        });
        break;
      case 'strike':
      case 'underline': {
        const y = a.type === 'underline' ? minY - 1.5 : (y1 + y2) / 2;
        page.drawLine({
          start: { x: minX, y: pageH - y },
          end: { x: maxX, y: pageH - y },
          thickness: (a.width || 2) / s, color: rgb,
        });
        break;
      }
      case 'freehand':
        for (const [ax, ay, bx, by] of a.segs) {
          page.drawLine({
            start: { x: ax / s, y: pageH - ay / s },
            end: { x: bx / s, y: pageH - by / s },
            thickness: (a.width || 2) / s, color: rgb,
          });
        }
        break;
      case 'note':
        page.drawRectangle({
          x: minX, y: minY, width: 12 / s, height: 12 / s,
          color: rgb, borderColor: PL.rgb(0.7, 0.45, 0), borderWidth: 0.7,
        });
        break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* API principal                                                       */
/* ------------------------------------------------------------------ */

/** Dibuja todo el estado del editor sobre un pdf-lib doc ya existente. */
export async function applyToDoc(doc, onProgress) {
  resetFontCache();
  const pages = doc.getPages();
  let step = 0;
  const total = Math.max(1, pages.length);
  const tick = m => { step++; onProgress && onProgress(m, step / total); };

  // 0 · Rotaciones de página (acumuladas, se aplican sobre la rotación previa)
  for (const op of S.pageOps || []) {
    if (op.type !== 'rotate') continue;
    const page = pages[op.page - 1];
    if (!page) continue;
    const next = ((page.getRotation().angle + op.by) % 360 + 360) % 360;
    page.setRotation(PL.degrees(next));
  }

  // 1 · OCR: capa de texto buscable
  const ocrPages = Object.keys(S.ocrBoxes);
  if (ocrPages.length) {
    const font = await getFont(doc, 'Helvetica');
    for (const p of ocrPages) {
      const page = pages[+p - 1];
      if (page) drawInvisibleLayer(page, S.ocrBoxes[p], font);
    }
  }
  tick('capa de texto');

  // 2 · Tapados y borrados
  for (const p of Object.keys(S.editItems)) {
    const page = pages[+p - 1];
    if (!page) continue;
    for (const it of S.editItems[p]) {
      if (it.kind === 'cover' || it.kind === 'whiteout' || it.kind === 'redact') drawCover(page, it);
    }
  }
  tick('tapados');

  // 3 · Texto e imágenes editados
  for (const p of Object.keys(S.editItems)) {
    const page = pages[+p - 1];
    if (!page) continue;
    for (const it of S.editItems[p]) {
      if (it.kind === 'text') await drawText(page, it);
      else if (it.kind === 'image') await drawImage(page, it);
    }
  }
  tick('texto e imágenes');

  // 4 · Firmas
  for (const p of Object.keys(S.inkImages)) {
    const page = pages[+p - 1];
    if (page) await drawSignature(doc, page, +p);
  }
  tick('firmas');

  // 5 · Formularios
  const nFields = await drawForms(doc, pages);
  if (nFields) tick(nFields + ' campos');

  // 6 · Anotaciones
  for (const p of Object.keys(S.annots)) {
    const page = pages[+p - 1];
    if (page) drawAnns(page, +p);
  }
  tick('anotaciones');

  return doc;
}

/** Carga el original y aplica los cambios. Devuelve bytes. */
export async function build(opts = {}) {
  const doc = await PL.PDFDocument.load(S.originalBytes, {
    ignoreEncryption: true, updateMetadata: false,
  });
  await applyToDoc(doc, opts.onProgress);
  return await doc.save({ useObjectStreams: true });
}

export async function saveDefault() {
  const bytes = await build();
  download(bytes, baseName() + '-editado.pdf');
  return bytes;
}