/* Genera un PDF idéntico al curriculum del usuario:
   - nombre centrado
   - una línea con viñeta y dos datos
   - el párrafo largo repartido en TRES renglones
   - "Educación" centrado
   - título a la izquierda + año a la derecha (y también al revés)
   - tildes (í, ó) y viñeta, como en el original
   Se usa para comprobar que al corregir una línea se mantienen el orden,
   la escritura, la tipografía y los márgenes. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { stubBrowser, loadVendor } = await import('./load-vendor.mjs');
const PL = stubBrowser();
const fk = loadVendor('fontkit.umd.min.js');
mkdirSync(resolve(here, 'fixtures'), { recursive: true });
const P = PL.PDFName;

/* [x, y, tamaño, texto, alineación]  alineación: 'L' izquierda, 'C' centro, 'R' derecha */
const LINEAS = [
  [380, 520, 15, 'MAMANI MANDAMIENTO EDWIN OMAR', 'C'],
  [380, 503, 10, '• omar-28-01@hotmail.com • 931786092', 'C'],
  [380, 488, 10, 'www.linkedin.com/in/edwin-omar-m-m/', 'C'],

  /* el párrafo: en el PDF real son tres renglones con el mismo estilo */
  [200, 466, 11, 'Ingeniería de Sistemas e Informática, con interés en desarrollo, soporte Ti, redes y seguridad', 'L'],
  [200, 452, 11, 'informática. Busco aprender y aportar en proyectos innovadores dentro de la industria', 'L'],
  [200, 438, 11, 'tecnológica.', 'L'],

  [380, 408, 13, 'Educación', 'C'],

  [48, 385, 13, 'UNIVERSIDAD NORBERT WIENER', 'L'],
  [712, 385, 11, '2020-2024', 'R'],
  [48, 368, 11, 'Ingeniería de Sistemas e Informática', 'L'],
  [48, 352, 11, 'Lima', 'L'],

  [48, 325, 13, 'UNIVERSIDAD LAS AMÉRICAS', 'L'],
  [712, 325, 11, '2019', 'R'],
  [48, 308, 11, 'Ingeniería de Sistemas e Informática', 'L'],
  [48, 292, 11, 'Lima', 'L'],
];

const doc = await PL.PDFDocument.create();
doc.registerFontkit(fk);
const font = await doc.embedFont(
  new Uint8Array(readFileSync(resolve(here, 'fixtures/arialn.ttf'))), { subset: false });
const page = doc.addPage([760, 560]);

const anchoDe = (txt, size) => {
  try { return font.widthOfTextAtSize(txt, size); } catch { return txt.length * size * 0.45; }
};
/* x de cada línea según su alineación */
const xDe = (txt, size, al) => {
  const w = anchoDe(txt, size);
  if (al === 'C') return Math.round((760 - w) / 2 * 100) / 100;
  if (al === 'R') return Math.round((712 - w) * 100) / 100;
  return txt === '' ? 0 : 48;
};

for (const [, y, size, txt, al] of LINEAS) {
  if (!txt) continue;
  page.drawText(txt, { x: xDe(txt, size, al), y, size, font });
}

let bytes = await doc.save();
const usados = new Set(LINEAS.map(l => l[3]).join('').split(''));

/* una sola fuente para todo el documento, como en los PDF reales */
{
  const d = await PL.PDFDocument.load(bytes, { ignoreEncryption: true });
  const primera = new Map();
  for (const pg of d.getPages()) {
    const fontes = pg.node.Resources().lookup(P.of('Font'));
    if (!fontes) continue;
    for (const k of [...fontes.keys()]) {
      const n = String(k);
      if (!primera.has(n)) primera.set(n, fontes.lookup(k));
    }
  }
  const destino = [...primera.values()][0];
  for (const pg of d.getPages()) {
    const fontes = pg.node.Resources().lookup(P.of('Font'));
    if (!fontes) continue;
    for (const k of [...fontes.keys()]) fontes.set(k, destino);
  }
  bytes = await d.save();
}

/* se recorta la fuente a los caracteres usados */
{
  const d = await PL.PDFDocument.load(bytes, { ignoreEncryption: true });

  async function leer(stream) {
    let raw = stream.asUint8Array();
    if (/FlateDecode/.test(String(stream.dict.get(P.of('Filter')) || ''))) {
      const ds = new DecompressionStream('deflate');
      raw = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer());
    }
    return Array.from(raw).map(b => String.fromCharCode(b)).join('');
  }
  function pares(txt) {
    const mapa = new Map();
    const hx = h => String.fromCharCode(parseInt(h, 16));
    for (const b of txt.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
      const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]{4})>/g;
      let m; while ((m = re.exec(b))) mapa.set(parseInt(m[1], 16), hx(m[2]));
    }
    for (const b of txt.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
      const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]{4})>/g;
      let m;
      while ((m = re.exec(b))) {
        const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), dst = parseInt(m[3], 16);
        for (let i = lo; i <= hi && i - lo < 3000; i++) mapa.set(i, String.fromCharCode(dst + i - lo));
      }
    }
    return mapa;
  }

  let n = 0;
  const vistos = new Set();
  for (const pg of d.getPages()) {
    const fontes = pg.node.Resources().lookup(P.of('Font'));
    if (!fontes) continue;
    for (const k of [...fontes.keys()]) {
      const ref = fontes.get(P.of(String(k).slice(1)));
      const clave = String(ref.toString());
      if (vistos.has(clave)) continue;
      vistos.add(clave);
      const fd = d.context.lookup(ref);
      const tu = fd.get(P.of('ToUnicode'));
      if (!tu) continue;
      const st = tu.asUint8Array ? tu : d.context.lookup(tu);
      const mapa = pares(await leer(st));
      const entradas = [...mapa.entries()].filter(([, ch]) => usados.has(ch))
        .map(([c, ch]) => `<${c.toString(16).padStart(4, '0')}> <${ch.charCodeAt(0).toString(16).padStart(4, '0')}>`);
      const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <ffff>
endcodespacerange
${entradas.length} beginbfchar
${entradas.join('\n')}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
      d.context.assign(tu.asUint8Array ? tu.ref : tu,
        d.context.flateStream(Uint8Array.from(cmap, c => c.charCodeAt(0))));
      n++;
    }
  }
  bytes = await d.save();
  console.log('fuentes recortadas:', n);
}

writeFileSync(resolve(here, 'fixtures/cv-real.pdf'), bytes);
console.log('fixtures/cv-real.pdf:', bytes.length, 'bytes ·', LINEAS.length, 'líneas ·', usados.size, 'caracteres');
console.log('con tilde:', [...usados].filter(c => c.charCodeAt(0) > 127).join(' ') || 'ninguna');
console.log('viñeta incluida:', usados.has('•'));