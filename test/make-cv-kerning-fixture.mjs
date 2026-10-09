/* Genera un PDF cuya línea larga está dibujada con kerning (operador TJ
   con varios trozos), como el Word/Canvas de muchos curricula. Ahí es donde
   el texto salía duplicado al corregirlo. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { stubBrowser, loadVendor } = await import('./load-vendor.mjs');
const PL = stubBrowser();
const fk = loadVendor('fontkit.umd.min.js');
mkdirSync(resolve(here, 'fixtures'), { recursive: true });
const P = PL.PDFName;

const LINEAS = [
  [380, 520, 15, 'MAMANI MANDAMIENTO EDWIN OMAR', 'C'],
  [380, 503, 10, '• omar-28-01@hotmail.com • 931786092', 'C'],
  [380, 488, 10, 'www.linkedin.com/in/edwin-omar-m-m/', 'C'],
  [48, 466, 11, 'Ingeniería de Sistemas e Informática, con interés en desarrollo, soporte Ti, redes y seguridad', 'L'],
  [48, 452, 11, 'informática. Busco aprender y aportar en proyectos innovadores dentro de la industria', 'L'],
  [48, 438, 11, 'tecnológica.', 'L'],
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

const anchoDe = (txt, size) => { try { return font.widthOfTextAtSize(txt, size); } catch { return txt.length * size * 0.45; } };
const xDe = (txt, size, al) => {
  const w = anchoDe(txt, size);
  if (al === 'C') return Math.round((760 - w) / 2 * 100) / 100;
  if (al === 'R') return Math.round((712 - w) * 100) / 100;
  return 48;
};

/* se dibuja una vez para tener la fuente y el mapa de códigos */
const codigoDe = new Map();
for (const [, y, size, txt] of LINEAS) if (txt) page.drawText(txt, { x: xDe(txt, size, 'L'), y, size, font });

let bytes = await doc.save();
{
  const d = await PL.PDFDocument.load(bytes, { ignoreEncryption: true });
  const fontes = d.getPages()[0].node.Resources().lookup(P.of('Font'));
  const ref = fontes.get(P.of(String([...fontes.keys()][0]).slice(1)));
  const fd = d.context.lookup(ref);
  const tu = fd.get(P.of('ToUnicode'));
  const st = tu.asUint8Array ? tu : d.context.lookup(tu);
  let raw = st.asUint8Array();
  if (/FlateDecode/.test(String(st.dict.get(P.of('Filter')) || ''))) {
    const ds = new DecompressionStream('deflate');
    raw = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer());
  }
  const txt = Array.from(raw).map(b => String.fromCharCode(b)).join('');
  for (const b of txt.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]{4})>/g;
    let m; while ((m = re.exec(b))) {
      codigoDe.set(String.fromCharCode(parseInt(m[2], 16)), parseInt(m[1], 16));
    }
  }
}

const hx = c => c.toString(16).padStart(4, '0');
const esc = s => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/* Flujo de contenido escrito a mano: las líneas largas usan TJ con varios
   trozos y ajuste de Kerning, igual que las escribe Word o un navegador. */
const ops = [];
for (const [, y, size, txt, al] of LINEAS) {
  if (!txt) continue;
  const x = xDe(txt, size, al);
  const nombre = String([...page.node.Resources().lookup(P.of('Font')).keys()][0]).slice(1);
  const codigos = [...txt].map(ch => codigoDe.get(ch));
  if (codigos.some(c => c === undefined)) throw new Error('carácter sin código: ' + txt);

  const esLarga = txt.length > 40;
  if (esLarga) {
    /* TJ: la frase se parte en trozos de 6 letras con un pequeño ajuste */
    const trozos = [];
    for (let i = 0; i < codigos.length; i += 6) {
      const parte = codigos.slice(i, i + 6);
      trozos.push(`<${parte.map(hx).join('')}> ${i + 6 < codigos.length ? '-18' : ''}`);
    }
    ops.push(`BT /${nombre} ${size} Tf 1 0 0 1 ${x} ${y} Tm [${trozos.join(' ')}] TJ ET`);
  } else {
    ops.push(`BT /${nombre} ${size} Tf 1 0 0 1 ${x} ${y} Tm <${codigos.map(hx).join('')}> Tj ET`);
  }
}
page.node.set(P.of('Contents'), doc.context.stream(Uint8Array.from(ops.join('\n'), c => c.charCodeAt(0))));

bytes = await doc.save();
const usados = new Set(LINEAS.map(l => l[3]).join('').split(''));

/* una fuente, recortada a los caracteres usados */
{
  const d = await PL.PDFDocument.load(bytes, { ignoreEncryption: true });
  const fontes = d.getPages()[0].node.Resources().lookup(P.of('Font'));
  const ref = fontes.get(P.of(String([...fontes.keys()][0]).slice(1)));
  const fd = d.context.lookup(ref);
  const tu = fd.get(P.of('ToUnicode'));
  const st = tu.asUint8Array ? tu : d.context.lookup(tu);
  let raw = st.asUint8Array();
  if (/FlateDecode/.test(String(st.dict.get(P.of('Filter')) || ''))) {
    const ds = new DecompressionStream('deflate');
    raw = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer());
  }
  const txt = Array.from(raw).map(b => String.fromCharCode(b)).join('');
  const mapa = new Map();
  for (const b of txt.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]{4})>/g;
    let m; while ((m = re.exec(b))) mapa.set(parseInt(m[1], 16), String.fromCharCode(parseInt(m[2], 16)));
  }
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
  bytes = await d.save();
}

writeFileSync(resolve(here, 'fixtures/cv-kerning.pdf'), bytes);
const largas = LINEAS.filter(l => l[3].length > 40).length;
console.log('fixtures/cv-kerning.pdf:', bytes.length, 'bytes ·', LINEAS.length, 'líneas ·',
  largas, 'con kerning (TJ) ·', usados.size, 'caracteres');