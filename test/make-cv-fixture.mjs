/* Genera un PDF tipo curriculum REALISTA:
   - una sola fuente incrustada y recortada para todo el documento,
     compartida por todas las líneas (como en un PDF de verdad)
   - frases repetidas en varias líneas
   - fechas alineadas a la derecha
   Sirve para comprobar que al editar una línea se modifica ESA línea
   y que se conservan el formato y la letra. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { stubBrowser, loadVendor } = await import('./load-vendor.mjs');
const PL = stubBrowser();
const fk = loadVendor('fontkit.umd.min.js');
mkdirSync(resolve(here, 'fixtures'), { recursive: true });
const P = PL.PDFName;

/* LAYOUT: [x, y, tamaño, texto] */
const LINEAS = [
  [40, 520, 15, 'MAMANI MANDAMIENTO EDWIN OMAR'],
  [40, 495, 10, 'omar-28-01@hotmail.com'],
  [40, 480, 10, 'www.linkedin.com/in/edwin-omar-m-m/'],

  [40, 450, 11, 'Ingenieria de Sistemas e Informatica, con intereses en desarrollo.'],
  [40, 436, 11, 'Ingenieria de Sistemas e Informatica, con intereses en desarrollo.'],

  [40, 405, 13, 'UNIVERSIDAD NORBERT WIENER'],
  [660, 405, 11, '2020-2024'],
  [40, 385, 10, 'Ingenieria de Sistemas e Informatica'],
  [40, 368, 10, 'Lima'],

  [40, 335, 13, 'UNIVERSIDAD LAS AMERICAS'],
  [690, 335, 11, '2019'],
  [40, 315, 10, 'Ingenieria de Sistemas e Informatica'],
  [40, 298, 10, 'Lima'],

  [40, 265, 13, 'CANVIA'],
  [660, 265, 11, 'Lima, Peru'],
  [40, 245, 10, 'Especialista de soporte Service Desk N2'],
  [660, 245, 10, '2024 - Actualidad'],
];

const doc = await PL.PDFDocument.create();
doc.registerFontkit(fk);
const font = await doc.embedFont(
  new Uint8Array(readFileSync(resolve(here, 'fixtures/arialn.ttf'))), { subset: false });
const page = doc.addPage([760, 560]);
for (const [x, y, size, txt] of LINEAS) page.drawText(txt, { x, y, size, font });

let bytes = await doc.save();
const usados = new Set(LINEAS.map(l => l[3]).join('').split(''));

/* ---- se fusionan todas las fuentes de la página en una sola ---- */
{
  const d = await PL.PDFDocument.load(bytes, { ignoreEncryption: true });
  const paginas = d.getPages();
const primera = new Map();
  for (const pg of paginas) {
    const fontes = pg.node.Resources().lookup(P.of('Font'));
    if (!fontes) continue;
    for (const k of [...fontes.keys()]) {
      const nombre = String(k);
      if (!primera.has(nombre)) primera.set(nombre, fontes.lookup(k));
    }
  }
  /* todas las claves apuntan al mismo recurso */
  for (const pg of paginas) {
    const recursos = pg.node.Resources();
    const fontes = recursos.lookup(P.of('Font'));
    if (!fontes) continue;
    const destino = [...primera.values()][0];
    for (const k of [...fontes.keys()]) fontes.set(k, destino);
  }
  bytes = await d.save();
  console.log('fuentes fusionadas en una:', [...primera.keys()].join(', '));
}

/* ---- se recorta esa fuente a los caracteres usados ---- */
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

writeFileSync(resolve(here, 'fixtures/cv.pdf'), bytes);
console.log('fixtures/cv.pdf:', bytes.length, 'bytes ·', LINEAS.length, 'líneas ·', usados.size, 'caracteres');