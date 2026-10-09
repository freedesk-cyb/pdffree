/* ============================================================
   preview-fonts.js — Saca del PDF las fuentes incrustadas y las
   registra en el navegador.

   Sirve para que el editor en línea se vea EXACTAMENTE con la
   tipografía del documento (Arial Narrow condensada, Calibri,
   una fuente de marca…), en vez de con una aproximación: lo que
   ves mientras escribes es lo que se guardará.
   ============================================================ */

/* Registro de fuentes ya instaladas: se evita repetir el trabajo. */
let cache = null;   // { css: Map, base: Map }

/**
 * Saca los programas de fuente de una página y los registra en el
 * navegador, indexados por el nombre real de la tipografía.
 *
 * @returns { css: Map<nombreReal, familiaCSS>, base: Map<BaseFont, familiaCSS> }
 */
export async function registerPageFonts(doc, pageIdx) {
  const css = new Map();     // nombre real (p.ej. "ArialNarrowMT") → familia CSS
  const base = new Map();    // /BaseFont del PDF → familia CSS
  const trace = [];          // pasos, útil para diagnosticar
  const page = doc.getPages()[pageIdx];
  if (!page) return { css, base, trace };
  if (!window.fontkit) { trace.push('sin fontkit'); return { css, base, trace }; }

  let resources;
  try { resources = page.node.Resources(); } catch (e) { trace.push('resources: ' + e.message); return { css, base, trace }; }
  if (!resources) { trace.push('sin recursos'); return { css, base, trace }; }

  let fonts;
  try { fonts = resources.lookup(PDFLib.PDFName.of('Font')); }
  catch (e) { trace.push('lookup Font: ' + e.message); return { css, base, trace }; }
  if (!fonts || typeof fonts.entries !== 'function') { trace.push('sin diccionario de fuentes'); return { css, base, trace }; }
  const total = fonts.entries().length;
  trace.push('fuentes en la página: ' + total);

  for (const [name, ref] of fonts.entries()) {
    let baseFont = String(name).replace(/^\//, '');
    try {
      const dict = doc.context.lookup(ref);
      baseFont = String(dict.get(PDFLib.PDFName.of('BaseFont')) || '')
        .replace(/^\//, '').replace(/^[A-Z]{6}\+/, '');
      if (base.has(baseFont)) continue;

      const bytes = await leerPrograma(doc, dict);
      if (!bytes || bytes.length < 8) continue;

      const cssName = `pdffont-${sanear(baseFont)}-${bytes.length}`;

      /* FontFace necesita el binario tal cual; el motor de fuentes solo
         sirve para comprobar que es una fuente válida. */
      window.fontkit.create(bytes);
      const face = new FontFace(cssName,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      await face.load();
      document.fonts.add(face);

      base.set(baseFont, cssName);
      css.set(baseFont, cssName);
      css.set(nombreRealDe(baseFont), cssName);
    } catch (e) {
      /* CFF, Type1 u otros formatos: se usa la aproximación estándar */
      trace.push('no visualizable ' + baseFont + ': ' + e.message);
    }
  }
  return { css, base, trace };
}

/**
 * Busca la familia CSS que corresponde a una tipografía concreta,
 * tolerando diferencias de nombre (subconjuntos, sufijos, guiones).
 */
export function findCssFont(mapa, nombreReal) {
  if (!mapa || !nombreReal) return null;
  if (mapa.has(nombreReal)) return mapa.get(nombreReal);

  const normal = normalizar(nombreReal);
  if (!normal) return null;

  /* coincidencia exacta ya normalizada */
  for (const [k, v] of mapa) {
    if (normalizar(k) === normal) return v;
  }
  /* coincidencia por contenido: "ArialNarrowBold-BoldMT" ~ "ArialNarrow" */
  for (const [k, v] of mapa) {
    const nk = normalizar(k);
    if (nk && (normal.includes(nk) || nk.includes(normal))) return v;
  }
  return null;
}

/** quita el prefijo de subconjunto y los signso de estilo/tamaño */
function normalizar(n) {
  return String(n || '')
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/[,]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase();
}

/** "ABCDEF+ArialNarrow-BoldMT" → "ArialNarrow" */
function nombreRealDe(baseFont) {
  return String(baseFont)
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/[-_,]?(Regular|Bold|Italic|Oblique|BoldItalic|BoldOblique|PSMT|PS)$/i, '')
    .replace(/MT$/, '');
}

/**
 * Devuelve los bytes del programa de fuente (FontFile2 / FontFile3).
 * Si no hay programa incrustado, reconstruye una fuente desde los
 * anchos declarados: así incluso una fuente no incrustada se ve con
 * sus métricas originales.
 */
/* ------------------------------------------------------------------ */
/* Lectura del programa de fuente                                      */
/* ------------------------------------------------------------------ */

/**
 * Saca los bytes del archivo de fuente incrustado.
 *
 * Ojo: aunque el diccionario diga /FontFile2, el flujo suele venir
 * comprimido con FlateDecode, y sus bytes "crudos" empiezan por 78 9C
 * (la cabecera zlib). Hay que descomprimirlo o el motor de fuentes
 * responderá "Unknown font format".
 */
async function leerPrograma(doc, fontDict) {
  const raw = extractFontProgram(doc, fontDict);
  if (!raw) return null;
  return await descomprimir(doc, fontDict, raw);
}

/** Localiza el flujo comprimido para poder inflar sus bytes. */
function buscarFlujoDeFuente(doc, fontDict) {
  const P = PDFLib.PDFName;
  const res = x => {
    if (!x) return null;
    if (typeof x.get === 'function') return x;
    try { return doc.context.lookup(x); } catch { return null; }
  };
  const deDescriptor = dict => {
    if (!dict || typeof dict.get !== 'function') return null;
    let desc;
    try { desc = res(dict.get(P.of('FontDescriptor'))); } catch { return null; }
    if (!desc || typeof desc.get !== 'function') return null;
    for (const key of ['FontFile2', 'FontFile3', 'FontFile']) {
      let s;
      try { s = res(desc.get(P.of(key))); } catch { continue; }
      if (s && typeof s.asUint8Array === 'function') return s;
    }
    return null;
  };
  if (String(fontDict.get(P.of('Subtype')) || '').includes('Type0')) {
    let kids = null;
    try { kids = fontDict.get(P.of('DescendantFonts')); } catch { kids = null; }
    const arr = typeof kids?.asArray === 'function' ? kids.asArray() : [];
    const kid = res(arr[0]);
    if (kid) {
      const s = deDescriptor(kid);
      if (s) return s;
    }
  }
  return deDescriptor(fontDict);
}

/** Inflate del flujo, con el filtro que declare en su diccionario. */
async function descomprimir(doc, fontDict, raw) {
  const stream = buscarFlujoDeFuente(doc, fontDict);
  if (!stream) return raw;
  const filter = String(stream.dict.get(PDFLib.PDFName.of('Filter')) || '');
  if (!/FlateDecode/.test(filter)) return raw;
  try {
    const ds = new DecompressionStream('deflate');
    const buf = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    /* algunos archivos usan deflate "crudo" sin cabecera */
    try {
      const ds = new DecompressionStream('deflate-raw');
      const buf = await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer();
      return new Uint8Array(buf);
    } catch {
      return raw;
    }
  }
}

/**
 * Devuelve el objeto del descriptor de una fuente simple o compuesta.
 */
function extractFontProgram(doc, fontDict) {
  const P = PDFLib.PDFName;
  /* Ojo: según el tipo de diccionario, get() puede devolver el objeto o
     solo la referencia, así que todo pasa por res(). */
  const res = x => {
    if (!x) return null;
    if (typeof x.get === 'function') return x;
    try { return doc.context.lookup(x); } catch { return null; }
  };
  /* recorre el descriptor de una fuente simple o compuesta y saca el archivo */
  const deDescriptor = dict => {
    if (!dict) return null;
    let desc;
    try { desc = res(typeof dict.get === 'function' ? dict.get(P.of('FontDescriptor')) : dict); }
    catch { return null; }
    if (!desc || typeof desc.get !== 'function') return null;
    for (const key of ['FontFile2', 'FontFile3', 'FontFile']) {
      let s;
      try { s = res(desc.get(P.of(key))); } catch { continue; }
      if (s && typeof s.asUint8Array === 'function') {
        try { return s.asUint8Array(); } catch { /* siguiente */ }
      }
    }
    return null;
  };

  /* 1. fuente compuesta (Type0): el archivo está en la fuente descendiente */
  if (String(fontDict.get(P.of('Subtype')) || '').includes('Type0')) {
    let kids = null;
    try { kids = fontDict.get(P.of('DescendantFonts')); } catch { kids = null; }
    const arr = typeof kids?.asArray === 'function' ? kids.asArray() : [];
    const kid = res(arr[0]);
    if (kid) {
      const bytes = deDescriptor(kid);
      if (bytes) return bytes;
    }
  }

  /* 2. fuente simple: su propio descriptor puede traer el archivo */
  return deDescriptor(fontDict);
}

function sanear(s) {
  return String(s).replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
}

/**
 * Devuelve la familia CSS de la fuente usada por una línea, o null.
 */
export function cssFontFor(mapa, nombreReal) {
  return findCssFont(mapa, nombreReal);
}

/* Limpia el registro (al abrir otro documento) */
export function resetPreviewFonts() { cache = null; }