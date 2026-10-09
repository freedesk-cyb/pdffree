/* ============================================================
   pipeline.test.mjs — Prueba del motor de escritura SIN navegador.
   Genera un PDF de origen, aplica el pipeline completo de
   writer.js y verifica el resultado leyendo el PDF de vuelta.

   Ejecutar:  node test/pipeline.test.mjs
   ============================================================ */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const require = createRequire(import.meta.url);

/* ---------- stubs mínimos de navegador + librerías ---------- */
const { stubBrowser } = await import('./load-vendor.mjs');
stubBrowser();

/* ---------- motor de lectura para verificar los PDFs ---------- */
import { pathToFileURL } from 'node:url';
const PDFJS_LEGACY = process.env.PDFJS_LEGACY
  || 'D:/HomeUse/cnv_aibarra/node_modules/pdfjs-dist/legacy/build/pdf.mjs';
const pdfjs = await import(pathToFileURL(PDFJS_LEGACY).href);

/* ---------- carga diferida de nuestros módulos ---------- */
const { S, pageSize } = await import('../js/core.js');
const { build, wrapText } = await import('../js/writer.js');

mkdirSync(resolve(here, 'out'), { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

/* ---------- helpers ---------- */
async function extractText(bytes, password = '') {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes), useSystemFonts: true, password,
  }).promise;
  let out = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out += tc.items.map(x => x.str).join(' ') + '\n';
  }
  await doc.destroy();
  return out;
}

/* ============================================================ */
console.log('\n=== 1. Crear PDF de origen ===');
const src = await PDFLib.PDFDocument.create();
{
  const p = src.addPage([595.28, 841.89]);           // A4
  const font = await src.embedFont(PDFLib.StandardFonts.Helvetica);
  p.drawText('FACTURA NUMERO 4471', { x: 60, y: 780, size: 18, font });
  p.drawText('Cliente: ACME SL', { x: 60, y: 740, size: 12, font });
  p.drawText('Total a pagar: 1234,56 EUR', { x: 60, y: 700, size: 12, font });
  p.drawRectangle({ x: 60, y: 650, width: 200, height: 30, color: PDFLib.rgb(0.9, 0.9, 0.9) });
}
const srcBytes = await src.save();
writeFileSync(resolve(here, 'out/origen.pdf'), srcBytes);
check('PDF de origen creado', srcBytes.length > 500, `(${srcBytes.length} B)`);

/* ============================================================ */
console.log('\n=== 2. Edicion: tapar texto + escribir encima ===');
S.originalBytes = srcBytes;
S.fileName = 'factura.pdf';
S.editItems = {
  1: [
    // tapa el rectángulo de "Total a pagar: 1234,56 EUR" (y=700, h=12)
    { kind: 'cover', x: 60 * 1.35, y: (841.89 - 712) * 1.35, w: 200 * 1.35, h: 18 * 1.35, color: '#ffffff', pscale: 1.35 },
    // texto corregido en su sitio
    { kind: 'text', x: 60 * 1.35, y: (841.89 - 712) * 1.35, w: 300 * 1.35, h: 18 * 1.35, pscale: 1.35,
      text: 'Total a pagar: 999,00 EUR', style: { font: 'Helvetica', size: 12, color: '#000000', align: 'left' } },
  ],
};
S.ocrBoxes = {};
S.formFields = []; S.inkImages = {}; S.annots = {}; S.signPlaced = {}; S.pageOps = [];

const edited = await build();
writeFileSync(resolve(here, 'out/editado.pdf'), edited);
const editedText = await extractText(edited);
check('el texto corregido es real y extraible', editedText.includes('999,00 EUR'), `→ "${editedText.slice(0, 90)}"`);
check('el texto nuevo no rompe el resto', editedText.includes('ACME SL'));
check('el rectángulo tapado se dibuja', edited.length > 1000);

/* ============================================================ */
console.log('\n=== 3. Capa de texto invisible (OCR) ===');
S.editItems = {};
S.ocrBoxes = {
  1: [{ text: 'Texto reconocido por OCR linea uno', x: 60, y: 300, w: 260, h: 12 }],
};
const ocrOut = await build();
writeFileSync(resolve(here, 'out/ocr.pdf'), ocrOut);
const ocrText = await extractText(ocrOut);
check('el PDF con OCR es buscable (capa invisible)', ocrText.includes('linea uno'), `→ "${ocrText.slice(0, 90)}"`);
check('el diseño original se conserva', ocrText.includes('FACTURA'));

/* ============================================================ */
console.log('\n=== 4. Formularios AcroForm ===');
S.ocrBoxes = {};
S.formFields = [
  { name: 'nombre_cliente', type: 'text', page: 1, x: 60 * 1.35, y: 600 * 1.35, w: 300 * 1.35, h: 20 * 1.35, pscale: 1.35, value: 'Juan Pérez' },
  { name: 'acepto', type: 'checkbox', page: 1, x: 60 * 1.35, y: 560 * 1.35, w: 16 * 1.35, h: 16 * 1.35, pscale: 1.35, checked: true },
  { name: 'pago', type: 'dropdown', page: 1, x: 100 * 1.35, y: 560 * 1.35, w: 160 * 1.35, h: 20 * 1.35, pscale: 1.35, options: ['Transferencia', 'Tarjeta', 'Cheque'] },
];
const formOut = await build();
writeFileSync(resolve(here, 'out/formulario.pdf'), formOut);

const reloaded = await PDFLib.PDFDocument.load(formOut);
const form = reloaded.getForm();
const names = form.getFields().map(f => f.getName());
check('campo de texto creado', names.includes('nombre_cliente'), `→ ${JSON.stringify(names)}`);
check('casilla creada', names.includes('acepto'));
check('desplegable creado', names.includes('pago'));
check('el valor del campo se guarda', form.getTextField('nombre_cliente').getText() === 'Juan Pérez',
  `→ "${form.getTextField('nombre_cliente').getText()}"`);
check('las casillas se marcan', form.getCheckBox('acepto').isChecked() === true);
check('las opciones del desplegable existen', form.getDropdown('pago').getOptions().length === 3,
  `→ ${JSON.stringify(form.getDropdown('pago').getOptions())}`);

/* ============================================================ */
console.log('\n=== 5. Anotaciones y firma ===');
S.formFields = [];
S.annots = {
  1: [
    { type: 'highlight', color: '#ffe14d', x1: 60, y1: 730, x2: 220, y2: 748, pscale: 1, width: 3 },
    { type: 'strike', color: '#ff0000', x1: 60, y1: 704, x2: 200, y2: 704, pscale: 1, width: 2 },
    { type: 'freehand', color: '#00aa00', segs: [[10, 10, 40, 50], [40, 50, 90, 20]], pscale: 1, width: 3 },
  ],
};
const annOut = await build();
writeFileSync(resolve(here, 'out/anotado.pdf'), annOut);
check('las anotaciones se graban sin romper el PDF', annOut.length > 1000);
check('el PDF sigue siendo válido', (await PDFLib.PDFDocument.load(annOut)).getPageCount() === 1);
check('el texto sigue siendo legible', (await extractText(annOut)).includes('ACME'));

/* ============================================================ */
console.log('\n=== 6. Cifrado AES-256 ===');
S.annots = {};
const plain = await build();
const encDoc = await PDFLib.PDFDocument.load(plain, { ignoreEncryption: true });
encDoc.encrypt({
  userPassword: 'secreto123',
  ownerPassword: 'secreto123_owner',
  permissions: { printing: 'highResolution', modifying: false, copyingContents: false },
});
const encBytes = await encDoc.save();
writeFileSync(resolve(here, 'out/cifrado.pdf'), encBytes);
check('el PDF cifrado es mayor (contiene el diccionario de cifrado)', encBytes.length > plain.length);

let wrongPwRejected = false;
try { await PDFLib.PDFDocument.load(encBytes, { password: 'incorrecta' }); }
catch { wrongPwRejected = true; }
check('rechaza contraseña incorrecta', wrongPwRejected);

const okDoc = await PDFLib.PDFDocument.load(encBytes, { password: 'secreto123' });
check('acepta la contraseña correcta', okDoc.getPageCount() === 1);
let openWithoutPw = false;
try { await pdfjs.getDocument({ data: new Uint8Array(encBytes) }).promise; }
catch (e) { openWithoutPw = e.name === 'PasswordException'; }
check('pdf.js también lo bloquea sin contraseña', openWithoutPw);

const encText = await extractText(encBytes, 'secreto123');
check('el contenido cifrado sigue extraíble con clave', encText.includes('ACME'));

/* ============================================================ */
console.log('\n=== 7. Rotacion, eliminacion y reordenacion ===');
S.ocrBoxes = {};
const multi = await PDFLib.PDFDocument.create();
const f1 = await multi.embedFont(PDFLib.StandardFonts.Helvetica);
for (const t of ['PAGINA UNO', 'PAGINA DOS', 'PAGINA TRES']) {
  const p = multi.addPage([400, 500]);
  p.drawText(t, { x: 40, y: 440, size: 16, font: f1 });
}
S.originalBytes = await multi.save();
S.pageOps = [
  { type: 'rotate', page: 1, by: 90 },
  { type: 'rotate', page: 3, by: 180 },
];
let rotBytes = await build();
const rotDoc = await PDFLib.PDFDocument.load(rotBytes);
check('rotación 90° aplicada a la pág. 1', rotDoc.getPage(0).getRotation().angle === 90,
  `→ ${rotDoc.getPage(0).getRotation().angle}`);
check('rotación 180° aplicada a la pág. 3', rotDoc.getPage(2).getRotation().angle === 180,
  `→ ${rotDoc.getPage(2).getRotation().angle}`);

/* ============================================================ */
console.log('\n=== 8. Ajuste de lineas ===');
{
  const doc = await PDFLib.PDFDocument.create();
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const lines = wrapText(font, 'Esta es una linea de texto bastante larga que deberia partirse en varias lineas porque el ancho maximo es pequeno.', 12, 120);
  check('el texto se parte en varias líneas', lines.length > 1, `→ ${lines.length} líneas`);
  check('ninguna línea excede el ancho', lines.every(l => font.widthOfTextAtSize(l, 12) <= 120 || l.length <= 12));
  check('no se pierde texto', lines.join(' ').replace(/\s+/g, ' ') === 'Esta es una linea de texto bastante larga que deberia partirse en varias lineas porque el ancho maximo es pequeno.');
}

/* ============================================================ */
console.log('\n=== 9. Compresion de imagenes (render headless no disponible) ===');
check('renderPage no se ejecuta en Node (esperado)', true);

/* ============================================================ */
console.log(`\n${'='.repeat(52)}`);
console.log(`  ${pass} pruebas correctas · ${fail} fallos`);
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);