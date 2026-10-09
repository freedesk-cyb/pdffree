/* Genera un PDF de prueba cuya fuente está recortada al texto usado,
   como las fuentes incrustadas de un PDF real (casi siempre son un
   subconjunto: si escribes una letra que no estaba, esa fuente no
   puede dibujarla).

   El motor de fuentes empaquetado no sabe subconjuntar, así que aquí
   se recorta a mano: se reescribe su mapa /ToUnicode dejando solo los
   caracteres que aparecen en la página. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { stubBrowser, loadVendor } = await import('./load-vendor.mjs');
const PL = stubBrowser();
const fk = loadVendor('fontkit.umd.min.js');
mkdirSync(resolve(here, 'fixtures'), { recursive: true });

const LINEAS = [
  'UNIVERSIDAD NORBERT WIENER',
  '2020-2024',
  'Ingenieria de Sistemas e Informatica, con intereses en desarrollo.',
  'CANVIA',
];

const doc = await PL.PDFDocument.create();
doc.registerFontkit(fk);
const font = await doc.embedFont(
  new Uint8Array(readFileSync(resolve(here, 'fixtures/arialn.ttf'))), { subset: false });
const page = doc.addPage([760, 340]);
page.drawText(LINEAS[0], { x: 40, y: 270, size: 13, font });
page.drawText(LINEAS[1], { x: 620, y: 270, size: 13, font });
page.drawText(LINEAS[2], { x: 40, y: 230, size: 13, font });
page.drawText(LINEAS[3], { x: 40, y: 180, size: 16, font });

const bytes = await doc.save();
const d2 = await PL.PDFDocument.load(bytes, { ignoreEncryption: true });
const P = PL.PDFName;

async function leerCMap(stream) {
  let raw = stream.asUint8Array();
  if (/FlateDecode/.test(String(stream.dict.get(P.of('Filter')) || ''))) {
    const ds = new DecompressionStream('deflate');
    raw = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer());
  }
  return Array.from(raw).map(b => String.fromCharCode(b)).join('');
}

/** Extrae los pares código→carácter de un CMap /ToUnicode */
function paresDeCMap(texto) {
  const mapa = new Map();
  const hx = h => String.fromCharCode(parseInt(h, 16));
  for (const bloque of texto.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]{4})>/g;
    let m;
    while ((m = re.exec(bloque))) mapa.set(parseInt(m[1], 16), hx(m[2]));
  }
  for (const bloque of texto.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]{4})>/g;
    let m;
    while ((m = re.exec(bloque))) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), dst = parseInt(m[3], 16);
      for (let i = lo; i <= hi && i - lo < 2000; i++) mapa.set(i, String.fromCharCode(dst + i - lo));
    }
  }
  return mapa;
}

const usados = new Set(LINEAS.join('').split(''));
const tocados = [];
const fuentes = d2.getPages()[0].node.Resources().lookup(P.of('Font'));
for (const [, ref] of fuentes.entries()) {
  const fd = d2.context.lookup(ref);
  const tu = fd.get(P.of('ToUnicode'));
  if (!tu) continue;
  const st = tu.asUint8Array ? tu : d2.context.lookup(tu);
  const mapa = paresDeCMap(await leerCMap(st));

  const lineas = [...mapa.entries()]
    .filter(([, ch]) => usados.has(ch))
    .map(([code, ch]) =>
      `<${code.toString(16).padStart(4, '0')}> <${ch.charCodeAt(0).toString(16).padStart(4, '0')}>`);

  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <ffff>
endcodespacerange
${lineas.length} beginbfchar
${lineas.join('\n')}
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

  const nuevo = d2.context.flateStream(Uint8Array.from(cmap, c => c.charCodeAt(0)));
  d2.context.assign(tu.asUint8Array ? tu.ref : tu, nuevo);
  tocados.push(lineas.length);
}

const salida = await d2.save();
writeFileSync(resolve(here, 'fixtures/subconjunto.pdf'), salida);

/* --- verificar que el recorte es real --- */
const d3 = await PL.PDFDocument.load(salida, { ignoreEncryption: true });
const f3 = d3.getPages()[0].node.Resources().lookup(P.of('Font'));
let mapaFinal = new Map();
for (const [, ref] of f3.entries()) {
  const fd = d3.context.lookup(ref);
  const tu = fd.get(P.of('ToUnicode'));
  const st = tu.asUint8Array ? tu : d3.context.lookup(tu);
  mapaFinal = paresDeCMap(await leerCMap(st));
}
const tiene = ch => [...mapaFinal.values()].includes(ch);

console.log('fixture:', salida.length, 'bytes ·', tocados.length, 'fuentes recortadas');
console.log('  mapa final:', mapaFinal.size, 'caracteres');
console.log('  "e" (sí se usa) presente :', tiene('e'));
console.log("  letras ausentes Z/Q:", ["Z","Q"].filter(z => !tiene(z)).join(", ") || "ninguna");
console.log('  "Ñ" (no se usa) ausente  :', !tiene('Ñ'));