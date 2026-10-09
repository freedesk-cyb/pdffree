/* Sonda: ¿qué información da pdf.js sobre cada línea de texto?
   Y ¿qué variantes de fuente tiene disponibles el motor de escritura? */
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const { stubBrowser } = await import('./load-vendor.mjs');
const PL = stubBrowser();

console.log('Fuentes estándar disponibles en el motor:');
console.log('  ' + Object.keys(PL.StandardFonts).join(', '));

const pdfjs = await import(pathToFileURL(
  process.env.PDFJS_LEGACY || 'D:/HomeUse/cnv_aibarra/node_modules/pdfjs-dist/legacy/build/pdf.mjs').href);

/* PDF con varias variantes tipográficas */
const doc = await PL.PDFDocument.create();
const p = doc.addPage([595, 300]);
const samples = [
  ['TimesRoman', 'TimesRoman', 14, 'Texto en Times Roman normal'],
  ['TimesRomanBold', 'TimesRomanBold', 14, 'Texto en Times Roman NEGRITA'],
  ['TimesRomanItalic', 'TimesRomanItalic', 14, 'Texto en Times Roman cursiva'],
  ['TimesRomanBoldItalic', 'TimesRomanBoldItalic', 14, 'Texto en Times Roman negrita cursiva'],
  ['Helvetica', 'Helvetica', 14, 'Texto en Helvetica normal'],
  ['HelveticaBold', 'HelveticaBold', 14, 'Texto en Helvetica negrita'],
];
let y = 260;
for (const [fname, , size, txt] of samples) {
  const f = await doc.embedFont(PL.StandardFonts[fname]);
  p.drawText(txt, { x: 40, y, size, font: f });
  y -= 30;
}
const bytes = await doc.save();

const dj = await pdfjs.getDocument({ data: bytes.slice(0), useSystemFonts: true }).promise;
const page = await dj.getPage(1);
const vp = page.getViewport({ scale: 1 });
const tc = await page.getTextContent();

console.log('\nLo que devuelve pdf.js por cada línea:');
for (const it of tc.items) {
  const tr = pdfjs.Util.transform(vp.transform, it.transform);
  const fontH = Math.hypot(tr[2], tr[3]);
  console.log(`\n  "${it.str.slice(0, 34)}"`);
  console.log(`    fontName  : ${it.fontName}`);
  console.log(`    styles    : ${JSON.stringify(tc.styles[it.fontName])}`);
  console.log(`    transform : [${it.transform.map(n => n.toFixed(2)).join(', ')}]`);
  console.log(`    size      : ${Math.abs(it.transform[3]).toFixed(2)}   ancho: ${it.width.toFixed(2)}`);
  console.log(`    ratio     : ${(it.width / it.str.length / Math.abs(it.transform[3])).toFixed(3)}  (ancho medio por carácter / tamaño)`);
  console.log(`    lineHeight: ${fontH.toFixed(2)}   baselineY: ${tr[5].toFixed(2)}`);
}
process.exit(0);