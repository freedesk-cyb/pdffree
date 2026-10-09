/* ============================================================
   inplace.js — Edición de texto EN SU SITIO, conservando la fuente
   incrustada del propio PDF.

   En lugar de tapar la línea y escribir encima con una fuente
   distinta, aquí se localiza el operador que dibuja esa línea
   dentro del flujo de contenido y se reescribe SOLO su cadena de
   texto. Se conservan intactos:

     · la fuente incrustada (glifos reales, condensed, negrita, cursiva)
     · el tamaño, el interletraje y el escalado horizontal
     · la posición exacta (matriz de texto)
     · el color y el resto del contenido de la página

   Si algo falla (PDF sin flujo localizable, glifo ausente en el
   subconjunto de la fuente, flujo comprimido raro…), se devuelve
   { ok:false } y quien llama usa el método alternativo de tapar.
   ============================================================ */

const PL = () => PDFLib;

/* ------------------------------------------------------------------ */
/* Tokenizador del flujo de contenido                                   */
/* ------------------------------------------------------------------ */
/**
 * Recorre el flujo de contenido sin reescribirlo,token a token.
 * Se reproducen los operadores de texto (Tf, Tm, Td, TJ, Tj…) para
 * saber qué fuente y qué posición tenía cada fragmento escrito.
 */
function* tokenize(content) {
  const len = content.length;
  let i = 0;
  while (i < len) {
    const ch = content[i];

    if (ch === '%' ) {                                  // comentario
      while (i < len && content[i] !== '\n' && content[i] !== '\r') i++;
      continue;
    }
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0') { i++; continue; }

    /* cadenas */
    if (ch === '(') {
      const start = i;
      let depth = 1; i++;
      while (i < len && depth > 0) {
        const c = content[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '(') depth++;
        else if (c === ')') depth--;
        i++;
      }
      yield { type: 'string', start, end: i, raw: content.slice(start, i) };
      continue;
    }
    if (ch === '<' && content[i + 1] !== '<') {
      const start = i;
      i++;
      while (i < len && content[i] !== '>') i++;
      i++;
      yield { type: 'string', start, end: i, raw: content.slice(start, i), hex: true };
      continue;
    }

    /* diccionarios y matrices: se saltan enteros */
    if (ch === '<' && content[i + 1] === '<') {
      let depth = 0;
      const start = i;
      while (i < len) {
        if (content[i] === '<' && content[i + 1] === '<') { depth++; i += 2; continue; }
        if (content[i] === '>' && content[i + 1] === '>') { depth--; i += 2; if (depth === 0) break; continue; }
        i++;
      }
      yield { type: 'dict', start, end: i };
      continue;
    }
    if (ch === '[' || ch === ']' || ch === '{' || ch === '}') {
      yield { type: ch, start: i, end: i + 1 };
      i++;
      continue;
    }

    /* nombres */
    if (ch === '/') {
      const start = i;
      i++;
      while (i < len && !/[\s/<>\[\](){}%]/.test(content[i])) i++;
      yield { type: 'name', start, end: i, raw: content.slice(start, i) };
      continue;
    }

    /* números */
    if (/[+-]?\d/.test(ch) || (ch === '.' && /\d/.test(content[i + 1] || ''))) {
      const start = i;
      i++;
      while (i < len && /[\d.\-+eE]/.test(content[i])) i++;
      yield { type: 'number', start, end: i, raw: content.slice(start, i) };
      continue;
    }

    /* palabra clave (operador) */
    if (/[A-Za-z'"*]/.test(ch)) {
      const start = i;
      while (i < len && /[A-Za-z0-9'"*]/.test(content[i])) i++;
      yield { type: 'op', start, end: i, raw: content.slice(start, i) };
      continue;
    }

    i++;
  }
}

/* ------------------------------------------------------------------ */
/* Cadenas: literales y hexadecimales                                   */
/* ------------------------------------------------------------------ */
export function decodeString(raw) {
  const bytes = [];
  if (raw[0] === '<') {
    const hex = raw.slice(1, -1).replace(/[^0-9a-fA-F]/g, '');
    for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
    if (hex.length % 2) bytes.push(parseInt(hex[hex.length - 1] + '0', 16));
    return Uint8Array.from(bytes);
  }
  let s = raw.slice(1, -1);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { bytes.push(c.charCodeAt(0) & 0xff); continue; }
    const n = s[++i];
    switch (n) {
      case 'n': bytes.push(10); break;
      case 'r': bytes.push(13); break;
      case 't': bytes.push(9); break;
      case 'b': bytes.push(8); break;
      case 'f': bytes.push(12); break;
      case '(': bytes.push(40); break;
      case ')': bytes.push(41); break;
      case '\\': bytes.push(92); break;
      case '\n': break;
      default:
        if (n >= '0' && n <= '7') {
          let oct = n;
          while (oct.length < 3 && s[i + 1] >= '0' && s[i + 1] <= '7') oct += s[++i];
          bytes.push(parseInt(oct, 8) & 0xff);
        } else bytes.push(n.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export function encodeString(bytes, useHex) {
  /* Se escribe siempre en hexadecimal: evita por completo los problemas de
     escape con paréntesis, barras invertidas y bytes de control. */
  return '<' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('') + '>';
}

/** Convierte una lista de códigos en bytes según la codificación de la fuente. */
export function codesToBytes(codes, twoByte) {
  if (!twoByte) return Uint8Array.from(codes);
  const out = new Uint8Array(codes.length * 2);
  codes.forEach((c, i) => { out[i * 2] = (c >> 8) & 0xff; out[i * 2 + 1] = c & 0xff; });
  return out;
}

/** Bytes → códigos, según la codificación de la fuente. */
export function bytesToCodes(bytes, twoByte) {
  if (!twoByte) return [...bytes];
  const out = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) out.push((bytes[i] << 8) | bytes[i + 1]);
  return out;
}

/* ------------------------------------------------------------------ */
/* Lectura y escritura de los flujos de contenido                      */
/* ------------------------------------------------------------------ */
/** Descomprime el flujo de contenido de un objeto PDF. */
async function decodeStream(context, stream) {
  const raw = stream.asUint8Array();
  const filters = String(stream.dict.get(PL().PDFName.of('Filter')) || '');
  if (!/FlateDecode/.test(filters)) return raw;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('este navegador no puede descomprimir el flujo');
  }
  const ds = new DecompressionStream('deflate');
  const stream_ = new Blob([raw]).stream().pipeThrough(ds);
  const buf = await new Response(stream_).arrayBuffer();
  return new Uint8Array(buf);
}

/* ------------------------------------------------------------------ */
/* CMap /ToUnicode                                                     */
/* ------------------------------------------------------------------ */
/**
 * Lee el CMap /ToUnicode de una fuente y lo invierte:
 *   código de byte  →  carácter
 * y también hacia delante:
 *   carácter         →  código de byte
 *
 * Es el diccionario que permite escribir el texto NUEVO con la misma
 * fuente incrustada, aunque esa fuente tenga los glifos renumerados.
 */
export function parseToUnicode(text) {
  const toUnicode = new Map();     // código → carácter
  const fromUnicode = new Map();   // carácter → un código representativo
  const codesFor = new Map();      // carácter → todos sus códigos

  /* rangos continuos:  <lo> <hi> <dstStart> */
  const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  for (const block of text.match(bfrangeRe) || []) {
    const body = block.replace(/beginbfrange|endbfrange/g, '');
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
    let m;
    while ((m = re.exec(body))) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (hi - lo > 65535) continue;
      if (m[3]) {
        const dst = parseInt(m[3], 16);
        for (let c = lo; c <= hi; c++) {
          const ch = String.fromCharCode(dst + (c - lo));
          add(toUnicode, fromUnicode, codesFor, c, ch);
        }
      } else {
        const items = (m[4].match(/<([0-9a-fA-F]+)>/g) || []).map(x => parseInt(x.slice(1, -1), 16));
        items.forEach((dst, k) => add(toUnicode, fromUnicode, codesFor, lo + k, String.fromCharCode(dst)));
      }
    }
  }

  /* caracteres sueltos:  <src> <dst> */
  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  for (const block of text.match(bfcharRe) || []) {
    const body = block.replace(/beginbfchar|endbfchar/g, '');
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let m;
    while ((m = re.exec(body))) {
      add(toUnicode, fromUnicode, codesFor, parseInt(m[1], 16), hexToUnicode(m[2]));
    }
  }
  return { toUnicode, fromUnicode, codesFor };
}

function add(a, b, all, code, ch) {
  if (!ch) return;
  a.set(code, ch);
  if (!all.has(ch)) all.set(ch, []);
  if (!all.get(ch).includes(code)) all.get(ch).push(code);
  if (!b.has(ch)) b.set(ch, code);
}

function hexToUnicode(hex) {
  const h = hex.padStart(4, '0');
  return String.fromCharCode(parseInt(h.slice(0, 4), 16));
}

/* ------------------------------------------------------------------ */
/* Anchuras de glifos (para colocar el texto en su sitio)              */
/* ------------------------------------------------------------------ */
function buildWidths(dict, context) {
  const first = intOf(dict.get(PL().PDFName.of('FirstChar')), 0);
  const arr = dict.get(PL().PDFName.of('Widths'));
  const widths = new Map();
  if (arr && typeof arr.size === 'function') {
    for (let i = 0; i < arr.size(); i++) {
      const w = intOf(context.lookup(arr.get(i)), 500);
      if (w > 0) widths.set(first + i, w);
    }
  }
  /* Ancho de glifo ausente: PDFDict.get() sí resuelve referencias
     indirectas (lookupMaybe no: exige una referencia). */
  let missing = 500;
  try {
    const desc = dict.get(PL().PDFName.of('FontDescriptor'));
    missing = intOf(desc?.get?.(PL().PDFName.of('MissingWidth')), 500);
  } catch { missing = 500; }
  const wArr = dict.get(PL().PDFName.of('W'));
  if (wArr && typeof wArr.size === 'function') {
    /* /W:  [ c [w1 w2 …] | cfirst clast w ] */
    let i = 0;
    while (i < wArr.size()) {
      const c = intOf(context.lookup(wArr.get(i)), null);
      const next = wArr.get(i + 1);
      const nextObj = context.lookup(next);
      if (nextObj && typeof nextObj.size === 'function') {
        for (let k = 0; k < nextObj.size(); k++) {
          widths.set(c + k, intOf(context.lookup(nextObj.get(k)), 500));
        }
        i += 2;
      } else {
        const clast = intOf(nextObj, c), w = intOf(context.lookup(wArr.get(i + 2)), 500);
        for (let c2 = c; c2 <= clast && c2 - c < 65536; c2++) widths.set(c2, w);
        i += 3;
      }
    }
  }
  return { widths, missing };
}

function intOf(v, dflt) {
  if (v == null) return dflt;
  const n = typeof v.asNumber === 'function' ? v.asNumber() : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/* Matrices PDF: [a b c d e f] */
const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];

/* ------------------------------------------------------------------ */
/* Localización de la fuente dentro de la página                       */
/* ------------------------------------------------------------------ */
function decodeBytes(bytes) {
  if (typeof TextDecoder === 'undefined') return String.fromCharCode(...bytes);
  return new TextDecoder('windows-1252').decode(bytes);
}

/**
 * Analiza un flujo de contenido y devuelve todos los fragmentos de
 * texto escritos, con su fuente, tamaño y posición.
 */
export function extractRuns(content, context, fontsOfPage) {
  const runs = [];
  const stack = [];
  let ultimoAbrir = null;
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  let fontRef = null, fontSize = 0, charSpace = 0, wordSpace = 0, hScale = 100, rise = 0, leading = 0;

  const num = v => {
    if (v == null) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const nameOf = v => String(v || '').replace(/^\//, '');

  const advanceOf = (bytes) => {
    const info = fontsOfPage.get(fontRef);
    if (!info) return 0;
    let w = 0;
    for (const code of bytesToCodes(bytes, info.twoByte)) {
      const gw = info.widths.get(code) ?? info.missing;
      w += gw * fontSize;
      if (!info.twoByte && code === 32) w += wordSpace * fontSize;
    }
    w += charSpace * fontSize * bytesToCodes(bytes, info.twoByte).length;
    return (w / 1000) * (hScale / 100);
  };

  for (const t of tokenize(content)) {
    if (t.type === 'number' || t.type === 'string' || t.type === 'name' || t.type === 'dict'
        || t.type === '[' || t.type === ']') {
      stack.push(t);
      /* La apertura del TJ se apunta aparte: una línea con kerning puede
         bringingdocenas de trozos y, con el límite de 32, el '[' se caía
         de la pila y la línea entera se descartaba sin editar nada. */
      if (t.type === '[') ultimoAbrir = t;
      if (stack.length > 20000) stack.shift();
      continue;
    }
    if (t.type !== 'op') continue;
    const op = t.raw;
    const args = stack;
    switch (op) {
      case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); break;
      case 'ET': break;
      case 'Tf': {
        fontRef = fontsOfPage.resolve(nameOf(args[args.length - 2]?.raw));
        fontSize = num(args[args.length - 1]?.raw);
        break;
      }
      case 'Td': tlm = mul([1, 0, 0, 1, num(args[args.length - 2]?.raw), num(args[args.length - 1]?.raw)], tlm); tm = tlm.slice(); break;
      case 'TD': leading = -num(args[args.length - 1]?.raw); tlm = mul([1, 0, 0, 1, num(args[args.length - 2]?.raw), num(args[args.length - 1]?.raw)], tlm); tm = tlm.slice(); break;
      case 'Tm': tlm = [0, 1, 2, 3, 4, 5].map(k => num(args[args.length - 6 + k]?.raw)); tm = tlm.slice(); break;
      case 'T*': tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); break;
      case 'TL': leading = num(args[args.length - 1]?.raw); break;
      case 'Tc': charSpace = num(args[args.length - 1]?.raw); break;
      case 'Tw': wordSpace = num(args[args.length - 1]?.raw); break;
      case 'Tz': hScale = num(args[args.length - 1]?.raw) || 100; break;
      case 'Ts': rise = num(args[args.length - 1]?.raw); break;
      case 'Tj':
      case "'":
      case '"': {
        if (op !== 'Tj') { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); }
        const st = [...args].reverse().find(a => a.type === 'string');
        if (st) pushRun(runs, st, tm, { fontRef, fontSize, charSpace, wordSpace, hScale, rise }, advanceOf, context, fontsOfPage);
        break;
      }
      case 'TJ': {
        const arr = ultimoAbrir
          && stack.includes(ultimoAbrir) ? ultimoAbrir
          : [...args].reverse().find(a => a.type === '[');
        if (arr) {
          const inner = content.slice(arr.end, findClose(content, arr.start));
          const pieces = [];
          let total = 0;
          for (const tk of tokenize(inner)) {
            /* OJO: los índices son absolutos dentro del flujo. Sin sumarle
               arr.end, la reescritura se aplicaba en el sitio equivocado y
               el texto salía corrupto o repetido. */
            tk.start += arr.end;
            tk.end += arr.end;
            if (tk.type === 'string') {
              const b = decodeString(tk.raw);
              pieces.push({ tk, bytes: b });
              total += advanceOf(b);
            } else if (tk.type === 'number') {
              const adj = -Number(tk.raw) / 1000 * fontSize * (hScale / 100);
              total += adj;
              pieces.push({ tk, adj });
            }
          }
          runs.push({
            kind: 'TJ', pieces,
            x: tm[4], y: tm[5] + rise, size: fontSize, fontRef,
            text: pieces.filter(p => p.bytes).map(p => toText(p.bytes, fontsOfPage, fontRef)).join(''),
          });
          tm = mul([1, 0, 0, 1, total, 0], tm);
          ultimoAbrir = null;
        }
        break;
      }
    }
    stack.length = 0;
  }
  return runs;
}

function findClose(content, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < content.length; i++) {
    if (content[i] === '[') depth++;
    else if (content[i] === ']') { depth--; if (depth === 0) return i; }
  }
  return content.length;
}

function pushRun(runs, st, tm, st2, advanceOf, context, fontsOfPage) {
  const bytes = decodeString(st.raw);
  runs.push({
    kind: 'Tj', st,
    x: tm[4], y: tm[5] + st2.rise, size: st2.fontSize, fontRef: st2.fontRef,
    text: toText(bytes, fontsOfPage, st2.fontRef),
    bytes,
  });
}

function toText(bytes, fontsOfPage, fontRef) {
  const info = fontsOfPage.get(fontRef);
  if (info && info.toUnicode) {
    return bytesToCodes(bytes, info.twoByte).map(c => info.toUnicode.get(c) ?? '').join('');
  }
  return decodeBytes(bytes);
}

/** Texto (caracteres) de un trozo de un TJ, según los códigos de la fuente. */
function runPieceText(piece, info) {
  if (!piece?.bytes) return '';
  if (info?.toUnicode) {
    return bytesToCodes(piece.bytes, info.twoByte).map(c => info.toUnicode.get(c) ?? '').join('');
  }
  return decodeBytes(piece.bytes);
}

/** Texto → códigos de la fuente. Los caracteres que no están usan los que ya
 *  había en la línea, para no inventar glifos. */
function textToCodes(texto, info, contexto = '') {
  const usados = usedCodes(contexto, info);
  const salida = [];
  for (const ch of texto) {
    const c = info.fromUnicode?.get(ch);
    if (c !== undefined) { salida.push(c); continue; }
    const deEjemplo = usados.get(ch);
    if (deEjemplo !== undefined) { salida.push(deEjemplo); continue; }
    const primero = usados.values().next();
    salida.push(primero.done ? (info.missing ?? 0) : primero.value);
  }
  return salida;
}

/* ------------------------------------------------------------------ */
/* API principal                                                       */
/* ------------------------------------------------------------------ */

/**
 * Sustituye el texto de una línea por otro usando la fuente incrustada
 * del propio PDF.
 *
 * @param doc        PDFDocument de pdf-lib
 * @param pageIndex  0-based
 * @param target     { text, x, y }  posición en unidades PDF (origen abajo)
 * @param newText    texto a escribir
 * @returns { ok, reason?, replaced? }
 */
export async function replaceTextInPlace(doc, pageIndex, target, newText) {
  try {
    return await doReplace(doc, pageIndex, target, newText);
  } catch (e) {
    return { ok: false, reason: e.message, stack: e.stack };
  }
}

async function doReplace(doc, pageIndex, target, newText) {
  const page = doc.getPages()[pageIndex];
  if (!page) return { ok: false, reason: 'página no encontrada' };

  const fontsOfPage = await buildFontIndex(doc, page);
  if (!fontsOfPage.size()) return { ok: false, reason: 'la página no tiene fuentes incrustadas' };

  const contents = page.node.Contents();
  if (!contents) return { ok: false, reason: 'la página no tiene flujo de contenido' };

  /* /Contents puede ser un único flujo o un array de ellos.
     asArray() devuelve PDFRef, que hay que resolver con context.lookup. */
  const isArray = contents instanceof PL().PDFArray;
  const entries = isArray ? contents.asArray() : [contents];
  const streams = [];
  for (const entry of entries) {
    let obj;
    try { obj = doc.context.lookup(entry); } catch { continue; }
    if (!obj || typeof obj.asUint8Array !== 'function') continue;
    let bytes;
    try { bytes = await decodeStream(doc.context, obj); }
    catch (e) { return { ok: false, reason: 'no se pudo descomprimir el flujo: ' + e.message }; }
    streams.push({ obj, ref: entry, content: bytesToString(bytes) });
  }
  if (!streams.length) return { ok: false, reason: 'no se pudo leer el flujo' };

  /* ¿con qué fuente se dibujó la línea? */
  let best = null;
  for (const st of streams) {
    const runs = extractRuns(st.content, doc.context, fontsOfPage);
    for (const r of runs) {
      if (!r.text || !r.text.trim()) continue;
      /* La línea puede contener el fragmento buscado (edición parcial) o
         ser exactamente ese fragmento (edición de la línea completa). */
      const exacta = normalise(r.text) === normalise(target.text);
      const contiene = !exacta && normalise(r.text).includes(normalise(target.text));
      if (!exacta && !contiene) continue;
      const dist = Math.hypot((r.x - target.x) / 10, (r.y - target.y) / 2);
      const score = dist + (exacta ? 0 : 5);
      if (!best || score < best.score) best = { score, run: r, stream: st, exacta, dist };
    }
  }
  if (!best) return { ok: false, reason: 'no se encontró el texto en el flujo' };
  if (best.dist > 6) return { ok: false, reason: 'la línea no coincide con ningún fragmento (coordenadas distintas)' };

  const info = fontsOfPage.get(best.run.fontRef);
  if (!info) return { ok: false, reason: 'fuente no reconocida' };

  /* Se reconstruye la cadena entera de la línea: se sustituye el
     fragmentoBuscado y se dejan intactos el resto de caracteres. */
  const nuevo = buildRunText(best.run, info, target.text, newText, best.exacta);
  if (!nuevo) return { ok: false, reason: 'la fuente incrustada no tiene los glifos necesarios' };
  const bytes = codesToBytes(nuevo, info.twoByte);

  /* Reescribe únicamente la cadena afectada; el resto del flujo queda
     byte a byte idéntico, así que no puede romperse nada del documento. */
  const content = best.stream.content;
  let newContent;
  if (best.run.kind === 'Tj') {
    newContent = content.slice(0, best.run.st.start)
      + encodeString(bytes)
      + content.slice(best.run.st.end);
  } else {
    /* TJ: una línea con kerning es una lista de trozos. Sustituir solo el
       primero dejaba el resto de los trozos intactos y el texto salía
       repetido ("Int de Sistemas... Busco" + el resto de la frase original).
       Ahora se reescribe la línea completa, dejando los ajustes de
       espaciado entre los trozos que siguen siendo válidos. */
    const primero = best.run.pieces[0];
    const ultimo = best.run.pieces[best.run.pieces.length - 1];
    if (!primero || !ultimo) return { ok: false, reason: 'fragmento TJ sin texto' };

    if (best.exacta) {
      /* línea completa: se deja un solo trozo con el texto nuevo */
      newContent = content.slice(0, primero.tk.start)
        + encodeString(bytes)
        + content.slice(ultimo.tk.end);
    } else {
      /* fragmento dentro de la línea: se sustituyen solo los trozos que
         cubren ese fragmento y se respeta el orden del resto */
      const desde = best.run.text.indexOf(target.text);
      const hasta = desde + target.text.length;
      if (desde < 0) {
        return { ok: false, reason: 'no se encontró el fragmento en la línea' };
      }
      /* Cada trozo se conserva byte a byte salvo el que contiene el
         fragmento: así lo que no se toca no puede alterarse. */
      let pos = 0, puesto = false;
      const partes = [];
      for (const p of best.run.pieces) {
        const txt = runPieceText(p, info);
        const ini = pos, fin = pos + txt.length;
        pos = fin;
        const fuera = !txt || fin <= desde || ini >= hasta;
        if (fuera) {
          partes.push(content.slice(p.tk.start, p.tk.end));
          continue;
        }
        const izq = txt.slice(0, Math.max(0, desde - ini));
        const der = txt.slice(Math.max(0, hasta - ini));
        const nuevoTrozo = izq + (puesto ? '' : newText) + der;
        puesto = true;
        partes.push(encodeString(codesToBytes(
          textToCodes(nuevoTrozo, info, best.run.text), info.twoByte)));
      }
      if (!puesto) return { ok: false, reason: 'el fragmento no cae en ningún trozo' };
      newContent = content.slice(0, primero.tk.start) + partes.join(' ')
        + content.slice(ultimo.tk.end);
    }
  }

  /* Se vuelve a escribir el flujo con la misma compresión */
  const encoded = stringToBytes(newContent);
  const filters = String(best.stream.obj.dict.get(PL().PDFName.of('Filter')) || '');
  const newStream = /FlateDecode/.test(filters)
    ? doc.context.flateStream(encoded)
    : PL().PDFRawStream.of(best.stream.obj.dict, encoded);
  escribirFlujo(doc, page, contents, entries, best.stream, newStream);

  return { ok: true, fontName: info.baseFont, chars: nuevo.length, twoByte: info.twoByte };
}

/**
 * Vuelve a escribir el flujo de contenido modificado.
 *
 * /Contents puede ser: una referencia indirecta (lo normal), un flujo DIRECTO
 * dentro del diccionario de la página, o un array de flujos. En el segundo
 * caso, asignar sobre "la referencia" —que ahí no existe— rompía el documento
 * entero y el guardado fallaba con un error de fuente. Aquí el flujo se
 * registra como objeto indirecto y se apunta desde donde estaba.
 */
function escribirFlujo(doc, page, contents, entries, stream, newStream) {
  if (stream.ref instanceof PL().PDFRef) {
    doc.context.assign(stream.ref, newStream);
    return;
  }
  /* flujo directo: se registra y se sustituye en su sitio */
  const ref = doc.context.register(newStream);
  if (contents instanceof PL().PDFArray) {
    const arr = contents.asArray();
    const i = entries.indexOf(stream.obj);
    if (i >= 0) arr[i] = ref;
    contents.update(arr);
  } else {
    page.node.set(PL().PDFName.of('Contents'), ref);
  }
}

function normalise(s) { return String(s).replace(/\s+/g, ' ').trim(); }

/**
 * Borra una línea del flujo de contenido (la deja vacía). Se usa cuando el
 * texto nuevo NO se puede escribir con la fuente incrustada: en vez de tapar
 * el original con un rectángulo —que lo deja ahí debajo, legible y
 * buscable— se elimina de verdad y el texto nuevo se escribe encima.
 */
export async function removeTextInPlace(doc, pageIndex, target) {
  try {
    return await doRemove(doc, pageIndex, target);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

async function doRemove(doc, pageIndex, target) {
  const page = doc.getPages()[pageIndex];
  if (!page) return { ok: false, reason: 'página no encontrada' };

  const fontsOfPage = await buildFontIndex(doc, page);
  const contents = page.node.Contents();
  if (!contents) return { ok: false, reason: 'la página no tiene flujo de contenido' };

  const isArray = contents instanceof PL().PDFArray;
  const entries = isArray ? contents.asArray() : [contents];

  let best = null;
  for (const entry of entries) {
    let obj;
    try { obj = doc.context.lookup(entry); } catch { continue; }
    if (!obj || typeof obj.asUint8Array !== 'function') continue;
    let bytes;
    try { bytes = await decodeStream(doc.context, obj); }
    catch { continue; }
    const st = { obj, ref: entry, content: bytesToString(bytes) };
    for (const r of extractRuns(st.content, doc.context, fontsOfPage)) {
      if (!r.text || !r.text.trim()) continue;
      const normR = normalise(r.text);
      const normT = normalise(target.text);
      const exacta = normR === normT;
      const contiene = !exacta && (normR.includes(normT) || normT.includes(normR));
      const dist = Math.hypot((r.x - target.x) / 10, (r.y - target.y) / 2);
      const cR = cleanText(r.text), cT = cleanText(target.text);
      const cercaY = Math.abs(r.y - target.y) < 5;
      const textoSimilar = cR === cT || (cR && cT && (cR.includes(cT) || cT.includes(cR)));

      if (!exacta && !contiene && !(cercaY && textoSimilar)) continue;

      const score = dist + (exacta ? 0 : (contiene ? 5 : 10));
      if (!best || score < best.score) best = { score, run: r, stream: st, exacta, dist };
    }
  }
  if (!best) return { ok: false, reason: 'no se encontró el texto a borrar' };
  if (best.dist > 10) return { ok: false, reason: 'la línea no coincide con ningún fragmento' };

  const content = best.stream.content;
  let newContent;
  if (best.run.kind === 'Tj') {
    /* cadena vacía: la línea deja de dibujarse, pero conserva tamaño y posición */
    newContent = content.slice(0, best.run.st.start) + encodeString(new Uint8Array(0))
      + content.slice(best.run.st.end);
  } else {
    /* Si la línea estaba repartida en varios trozos (kerning), se vacían
       TODOS: vaciar solo el primero dejaba el texto repartido. */
    const primero = best.run.pieces[0];
    const ultimo = best.run.pieces[best.run.pieces.length - 1];
    if (!primero || !ultimo) return { ok: false, reason: 'fragmento TJ sin texto' };
    newContent = content.slice(0, primero.tk.start) + encodeString(new Uint8Array(0))
      + content.slice(ultimo.tk.end);
  }

  const encoded = stringToBytes(newContent);
  const filters = String(best.stream.obj.dict.get(PL().PDFName.of('Filter')) || '');
  const newStream = /FlateDecode/.test(filters)
    ? doc.context.flateStream(encoded)
    : PL().PDFRawStream.of(best.stream.obj.dict, encoded);
  escribirFlujo(doc, page, contents, entries, best.stream, newStream);
  return { ok: true };
}

function bytesToString(bytes) {
  /* Los flujos son Latin-1 en PDF: un byte = un carácter */
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return out;
}
function stringToBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/* ------------------------------------------------------------------ */
/* Índice de fuentes de la página                                       */
/* ------------------------------------------------------------------ */
export async function buildFontIndex(doc, page) {
  const byName = new Map();
  const byRef = new Map();
  const api = {
    resolve: name => byName.get(name),
    get: ref => byRef.get(ref),
    size: () => byRef.size,
  };

  let res;
  try { res = page.node.Resources(); } catch { return api; }
  if (!res) return api;
  let fonts;
  try { fonts = res.lookup(PL().PDFName.of('Font')); } catch { return api; }
  if (!fonts || typeof fonts.entries !== 'function') return api;

  for (const [name, ref] of fonts.entries()) {
    byName.set(String(name).replace(/^\//, ''), ref);
    try {
      const info = await describeFont(doc, ref);
      if (info) byRef.set(ref, info);
    } catch { /* fuente ilegible: se ignora */ }
  }
  return api;
}

async function describeFont(doc, ref) {
  const dict = doc.context.lookup(ref);
  if (!dict || typeof dict.get !== 'function') return null;
  const P = PL().PDFName;
  const subtype = String(dict.get(P.of('Subtype')) || '');
  const baseFont = String(dict.get(P.of('BaseFont')) || '').replace(/^\//, '').replace(/^[A-Z]{6}\+/, '');
  const { widths, missing } = buildWidths(dict, doc.context);

  /* Las fuentes compuestas (Identity-H/V) usan códigos de 2 bytes */
  const encName = String(dict.get(P.of('Encoding')) || '');
  const twoByte = subtype.includes('Type0') || /Identity-[HV]/.test(encName);

  let toUnicode = null, fromUnicode = null, codesFor = null;
  const tuRef = dict.get(P.of('ToUnicode'));
  if (tuRef) {
    try {
      const stream = doc.context.lookup(tuRef);
      const bytes = await decodeStream(doc.context, stream);
      const cmap = parseToUnicode(latin1ToString(bytes));
      toUnicode = cmap.toUnicode; fromUnicode = cmap.fromUnicode; codesFor = cmap.codesFor;
    } catch { /* sin CMap: se usará la codificación por defecto */ }
  }
  return { ref, subtype, baseFont, widths, missing, toUnicode, fromUnicode, codesFor, twoByte };
}

function latin1ToString(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return out;
}

/* Convierte el texto nuevo en los códigos que usa esta fuente.
 * usando. Es la fuente de verdad más fiable: si un carácter aparece
 * varias veces en el CMap (variantes de glifo, subconjuntos repetidos),
 * reutilizar el código que ya está en el documento es lo que garantiza
 * que se dibuje exactamente el mismo glifo. */
/* Convierte el texto nuevo en los códigos que usa esta fuente.
 *
 * Si `findText` no es toda la línea, se reconstruye la línea completa
 * cambiando solo ese troceo: así el resto de la frase conserva sus
 * propios glifos y su posición relativa dentro del flujo. */
function buildRunText(run, info, findText, newText, esLineaCompleta) {
  if (!run.bytes) {
    /* el operador TJ guarda sus trozos por separado */
    return encodeNewText(newText, info, null);
  }
  const hint = hintFromRun(run, info);
  const codes = bytesToCodes(run.bytes, info.twoByte);
  const chars = codes.map(c => (info.toUnicode?.get(c) ?? decodeBytes(Uint8Array.of(c & 0xff, c >> 8))));

  if (esLineaCompleta) return encodeNewText(newText, info, hint);

  /* localizar el fragmento dentro de la línea */
  const texto = chars.join('');
  const plano = texto.replace(/\s+/g, ' ');
  const buscado = String(findText).replace(/\s+/g, ' ').trim();
  const pos = plano.indexOf(buscado);
  if (pos < 0) return encodeNewText(newText, info, hint);

  /* se conservan los códigos anteriores y se cambian solo los del fragmento */
  const nuevos = encodeNewText(newText, info, hint);
  if (!nuevos) return null;

  /* Los espacios del CMap pueden no coincidir 1:1 con los caracteres */
  let i = 0, j = 0;
  const salida = [];
  for (const ch of plano) {
    const enRango = i >= pos && i < pos + buscado.length;
    if (enRango) {
      /* si el texto nuevo es más corto, el sobrante del ORIGINAL se
         descarta (no se arrastra detrás de la frase nueva) */
      if (j < nuevos.length) salida.push(nuevos[j]);
      j++;
    } else {
      salida.push(codes[i] ?? ch.charCodeAt(0));
    }
    i++;
  }
  /* si el texto nuevo es más largo que el fragmento, se añade al final */
  while (j < nuevos.length) { salida.push(nuevos[j]); j++; }
  return salida;
}

const BULLETS = ['\u2022', '\u25CF', '\u25CB', '\u2023', '\u25E6', '\u00B7', '\uF0B7', '\u25FE', '\u25AA', '\u25AB'];

/* Traduce texto a códigos de esta fuente. */
function encodeNewText(text, info, hint) {
  const out = [];
  for (const ch of text) {
    if (ch === '\n' || ch === '\r') continue;
    let code = null;
    if (hint && hint.has(ch)) code = hint.get(ch);
    if (code == null && BULLETS.includes(ch)) {
      for (const b of BULLETS) {
        if (hint && hint.has(b)) { code = hint.get(b); break; }
        if (info?.fromUnicode && info.fromUnicode.has(b)) { code = pickCode(info, b); break; }
      }
    }
    if (code == null && info?.fromUnicode) {
      code = pickCode(info, ch);
    }
    if (code == null && !info?.fromUnicode && ch.charCodeAt(0) < 256) {
      code = ch.charCodeAt(0);              // fuente sin /ToUnicode: WinAnsi
    }
    if (code == null) return null;           // glifo ausente en el subconjunto
    out.push(code);
  }
  /* OJO: un array normal, no Uint8Array. Los códigos de una fuente
     Identity-H son identificadores de glifo y llegan hasta 65535: si se
     guardaran en un Uint8Array se truncarían a un byte y se escribiría
     el glifo equivocado. */
  return out;
}

/* Entre los códigos que apuntan al mismo carácter, preferimos el que
   tiene un ancho declarado (los glifos de un subconjunto a menudo se
   duplican en el CMap y solo algunos están presentes de verdad). */
function pickCode(info, ch) {
  const codes = info.codesFor?.get(ch);
  if (!codes || !codes.length) return info.fromUnicode?.get(ch);
  for (const c of codes) if (info.widths.get(c) > 0) return c;
  return codes[0];
}

/* Extrae de la línea original los pares (código → carácter) reales. */
function hintFromRun(run, info) {
  const map = new Map();
  if (!info?.toUnicode) return map;
  const allBytes = [];
  if (run?.bytes) {
    allBytes.push(run.bytes);
  } else if (run?.pieces) {
    for (const p of run.pieces) if (p.bytes) allBytes.push(p.bytes);
  }
  for (const b of allBytes) {
    for (const code of bytesToCodes(b, info.twoByte)) {
      const ch = info.toUnicode.get(code);
      if (ch && !map.has(ch)) map.set(ch, code);
    }
  }
  return map;
}