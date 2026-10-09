/* ============================================================
   inplace.test.mjs —” Edición EN SITIO conservando la fuente real.
   Crea PDFs con fuentes incrustadas (subconjunto propio) y comprueba
   que al corregir una línea:
     · se usa la fuente incrustada original, no una sustituta,
     · el glifo dibujado es el de la fuente real,
     · la posición no se mueve.
   ============================================================ */
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { stubBrowser, loadVendor } = await import('./load-vendor.mjs');
const PL = stubBrowser();
globalThis.fontkit = loadVendor('fontkit.umd.min.js');
const pdfjs = await import(pathToFileURL(
  process.env.PDFJS_LEGACY || 'D:/HomeUse/cnv_aibarra/node_modules/pdfjs-dist/legacy/build/pdf.mjs').href);

mkdirSync(resolve(here, 'out'), { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  OK   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)); };

const { S } = await import('../js/core.js');
const { build } = await import('../js/writer.js');
const { replaceTextInPlace } = await import('../js/inplace.js');

const FONTES = {
  condensada: 'C:/Windows/Fonts/ARIALN.TTF',          // Arial Narrow
  negrita: 'C:/Windows/Fonts/ARIALNB.TTF',           // Arial Narrow Bold
  normal: 'C:/Windows/Fonts/arial.ttf',
  calibri: 'C:/Windows/Fonts/calibri.ttf',
};

async function crearPdfConFuente(ruta, texto, opts = {}) {
  const doc = await PL.PDFDocument.create();
  doc.registerFontkit(globalThis.fontkit);
  const bytes = readFile(ruta);
  const font = await doc.embedFont(bytes, { subset: false });
  const p = doc.addPage([595.28, 400]);
  p.drawText(texto, { x: 50, y: opts.y ?? 300, size: opts.size ?? 14, font });
  if (opts.extra) p.drawText(opts.extra, { x: 50, y: (opts.y ?? 300) - 40, size: opts.size ?? 14, font });
  return { doc, font, bytes: await doc.save() };
}
import { readFileSync } from 'node:fs';
const readFile = p => new Uint8Array(readFileSync(p));

/** Devuelve la fuente BaseFont usada en la página (la incrustada real) */
function fuentesDe(doc, pageIndex = 0) {
  const page = doc.getPages()[pageIndex];
  const fonts = page.node.Resources().lookup(PL.PDFName.of('Font'));
  const out = [];
  for (const [, ref] of fonts.entries()) {
    const d = doc.context.lookup(ref);
    out.push(String(d.get(PL.PDFName.of('BaseFont')) || '').replace(/^[A-Z]{6}\+/, ''));
  }
  return out;
}

async function textoDe(bytes) {
  const d = await pdfjs.getDocument({ data: bytes.slice(0), useSystemFonts: true }).promise;
  const page = await d.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  return tc.items.filter(i => i.str.trim()).map(i => {
    const tr = pdfjs.Util.transform(vp.transform, i.transform);
    return { str: i.str, base: +(vp.height - tr[5]).toFixed(2), x: +tr[4].toFixed(1), w: +i.width.toFixed(1) };
  });
}

/* ================================================================= */
console.log('\n=== 1. Sustitución en el flujo con fuente incrustada ===');
{
  const ORIGINAL = 'Ingenieria de Sistemas e informatica';
  const NUEVO = 'CORREGIDO con la fuente real';
  const { doc, bytes } = await crearPdfConFuente(FONTES.normal, ORIGINAL, { extra: 'Segunda linea intacta' });

  /* Reutilizamos el mismo objeto que editaría la aplicación */
  S.originalBytes = bytes;
  S.fileName = 'fuente.pdf';
  S.editItems = {}; S.ocrBoxes = {}; S.formFields = []; S.inkImages = {}; S.annots = {}; S.signPlaced = {}; S.pageOps = [];

  const antes = await textoDe(bytes);
  const orig = antes[0];

  S.editItems = { 1: [{
    kind: 'text', pscale: 1.35, baseline: true,
    x: orig.x * 1.35, y: 0, w: orig.w * 1.35, h: 14 * 1.35,
    text: NUEVO, inplace: true, original: ORIGINAL,
    originalBox: { x: orig.x, y: 0, w: orig.w, h: 14, baseline: orig.base },
    coverColor: '#ffffff', coverPad: 2,
    style: { family: 'sans-serif', size: 14, color: '#000000' },
  }]};

  const out = await build();
  writeFileSync(resolve(here, 'out/inplace.pdf'), out);
  const item = S.editItems[1][0];

  check('se usó la edición en sitio (no la sustitución)', item._mode === 'in situ',
    `→ modo "${item._mode}" · ${item._inplaceError || 'sin error'}`);
  check('el PDF sigue siendo válido', (await PL.PDFDocument.load(out)).getPageCount() === 1);

  const despues = await textoDe(out);
  const nuevo = despues.find(l => l.str.includes('CORREGIDO'));
  check('el texto nuevo aparece en el PDF', !!nuevo, `→ ${despues.map(d => d.str.slice(0, 30)).join(' | ')}`);
  check('el texto original ya no está', !despues.some(l => l.str.includes('Ingenieria')));
  check('la línea de abajo no se ha tocado',
    despues.some(l => l.str.includes('Segunda linea intacta')));
  check('la línea base no se mueve', nuevo && Math.abs(nuevo.base - orig.base) < 0.5,
    `→ ${nuevo?.base} vs ${orig.base}`);
  check('la X no se mueve', nuevo && Math.abs(nuevo.x - orig.x) < 0.5,
    `→ ${nuevo?.x} vs ${orig.x}`);
}

/* ================================================================= */
console.log('\n=== 2. La fuente incrustada es la del PDF, no una sustituta ===');
{
  const { doc, bytes } = await crearPdfConFuente(FONTES.condensada, 'Texto condensado de prueba');
  const reloaded = await PL.PDFDocument.load(bytes, { ignoreEncryption: true });
  const fuentesAntes = fuentesDe(reloaded);
  check('el PDF de partida incrusta una fuente propia (subconjunto)',
    fuentesAntes.length === 1 && !/^(Helvetica|Times|Courier)/.test(fuentesAntes[0]),
    `→ ${fuentesAntes.join(', ')}`);

  S.originalBytes = bytes;
  S.editItems = { 1: [{
    kind: 'text', pscale: 1.35, baseline: true, x: 50 * 1.35, y: 0, w: 300 * 1.35, h: 14 * 1.35,
    text: 'Otro texto condensado', inplace: true, original: 'Texto condensado de prueba',
    originalBox: { x: 50, y: 0, w: 300, h: 14, baseline: 300 },
    coverColor: '#fff', style: { family: 'sans-serif', size: 14, color: '#000000' },
  }]};
  const out = await build();
  const reloaded2 = await PL.PDFDocument.load(out, { ignoreEncryption: true });
  const fuentesDespues = fuentesDe(reloaded2);

  check('sigue habiendo UNA sola fuente (no se añadió otra)',
    fuentesDespues.length === 1, `→ ${fuentesDespues.join(', ')}`);
  check('es la MISMA fuente incrustada del original',
    fuentesDespues[0] === fuentesAntes[0],
    `→ antes "${fuentesAntes[0]}" / después "${fuentesDespues[0]}"`);
  check('la edición fue en sitio', S.editItems[1][0]._mode === 'in situ',
    `→ ${S.editItems[1][0]._mode} ${S.editItems[1][0]._inplaceError || ''}`);

  const lineas = await textoDe(out);
  check('el texto se sustituyó', lineas.some(l => l.str.includes('Otro texto condensado')));
  check('la anchura es la de la fuente condensada real (no se estiró)',
    lineas[0] && lineas[0].w < 200, `→ ancho ${lineas[0]?.w} pt para 21 caracteres`);
}

/* ================================================================= */
console.log('\n=== 3. Negrita y cursiva incrustadas ===');
{
  for (const [etiqueta, ruta] of [['negrita', FONTES.negrita], ['normal', FONTES.calibri]]) {
    const ORIGINAL = 'Muestra de fuente';
    const { bytes } = await crearPdfConFuente(ruta, ORIGINAL);
    const antes = await textoDe(bytes);
    S.originalBytes = bytes;
    S.editItems = { 1: [{
      kind: 'text', pscale: 1.35, baseline: true, x: 50 * 1.35, y: 0, w: 300 * 1.35, h: 14 * 1.35,
      text: 'Texto sustituido', inplace: true, original: ORIGINAL,
      originalBox: { x: 50, y: 0, w: 300, h: 14, baseline: antes[0].base },
      coverColor: '#fff', style: { family: 'sans-serif', size: 14, color: '#000000' },
    }]};
    const out = await build();
    const d = await textoDe(out);
    /* el motor puede trocear la línea: buscamos la que contenga el texto */
    const conTexto = d.filter(l => l.str.trim());
    const nuevo = conTexto.find(l => /sustit/i.test(l.str)) || conTexto[0];
    check(`fuente ${etiqueta}: se editó en sitio`, S.editItems[1][0]._mode === 'in situ',
      `→ ${S.editItems[1][0]._mode} ${S.editItems[1][0]._inplaceError || ''}`);
    check(`fuente ${etiqueta}: conserva el avance de la fuente original`,
      nuevo && Math.abs(nuevo.w - antes[0].w) / antes[0].w < 0.25,
      `→ antes ${antes[0].w} pt / ahora ${nuevo?.w} pt ("${nuevo?.str.slice(0, 24)}")`);
  }
}

/* ================================================================= */
console.log('\n=== 4. Casos en los que debe caer a sustitución sin romperse ===');
{
  /* 4a. Texto que no existe en el PDF */
  const { bytes } = await crearPdfConFuente(FONTES.normal, 'Linea original');
  S.originalBytes = bytes;
  S.editItems = { 1: [{
    kind: 'text', pscale: 1.35, baseline: true, x: 50 * 1.35, y: 0, w: 300 * 1.35, h: 14 * 1.35,
    text: 'Reemplazo', inplace: true, original: 'UNA FRASE QUE NO EXISTE',
    originalBox: { x: 50, y: 0, w: 300, h: 14, baseline: 300 },
    coverColor: '#ffffff', coverPad: 2,
    style: { family: 'sans-serif', size: 14, color: '#000000' },
  }]};
  const out = await build();
  check('si no encuentra la línea, cae a sustitución', S.editItems[1][0]._mode === 'sustitución',
    `→ ${S.editItems[1][0]._mode}`);
  check('el PDF sigue siendo válido tras el respaldo', (await PL.PDFDocument.load(out)).getPageCount() === 1);
  const d = await textoDe(out);
  check('el texto de respaldo está en el PDF', d.some(l => l.str.includes('Reemplazo')));

  /* 4b. PDF escaneado: no hay flujo de texto */
  const scanned = await PL.PDFDocument.create();
  const pg = scanned.addPage([300, 300]);
  const png = tinyPng();
  const img = await scanned.embedPng(png);
  pg.drawImage(img, { x: 0, y: 0, width: 300, height: 300 });
  S.originalBytes = await scanned.save();
  S.editItems = { 1: [{
    kind: 'text', pscale: 1.35, baseline: true, x: 50 * 1.35, y: 0, w: 200 * 1.35, h: 14 * 1.35,
    text: 'Anotacion', inplace: true, original: 'nada',
    originalBox: { x: 50, y: 0, w: 200, h: 14, baseline: 200 },
    coverColor: '#ffffff', style: { family: 'sans-serif', size: 14, color: '#000000' },
  }]};
  const out2 = await build();
  check('un PDF sin texto cae a sustitución y no falla',
    S.editItems[1][0]._mode === 'sustitución', `→ ${S.editItems[1][0]._mode}`);
  check('el PDF escaneado sigue válido', (await PL.PDFDocument.load(out2)).getPageCount() === 1);

  /* 4c. Estructura intacta: varias páginas, operaciones de página y formulario */
  const multi = await PL.PDFDocument.create();
  multi.registerFontkit(globalThis.fontkit);
  const f = await multi.embedFont(readFile(FONTES.normal), { subset: false });
  for (const t of ['PRIMERA PAGINA', 'SEGUNDA PAGINA', 'TERCERA PAGINA']) {
    const p = multi.addPage([595, 300]);
    p.drawText(t, { x: 50, y: 200, size: 14, font: f });
  }
  S.originalBytes = await multi.save();
  S.pageOps = [{ type: 'rotate', page: 2, by: 90 }];
  S.editItems = { 1: [{
    kind: 'text', pscale: 1.35, baseline: true, x: 50 * 1.35, y: 0, w: 300 * 1.35, h: 14 * 1.35,
    text: 'PRIMERA CORREGIDA', inplace: true, original: 'PRIMERA PAGINA',
    originalBox: { x: 50, y: 0, w: 300, h: 14, baseline: 200 },
    coverColor: '#ffffff', style: { family: 'sans-serif', size: 14, color: '#000000' },
  }]};
  const out3 = await build();
  const doc3 = await PL.PDFDocument.load(out3);
  check('las otras páginas no se rompen', doc3.getPageCount() === 3);
  check('la rotación se sigue aplicando', doc3.getPage(1).getRotation().angle === 90);
  const t3 = await textoDe(out3);
  check('la página 1 se corrigió en sitio', S.editItems[1][0]._mode === 'in situ',
    `→ ${S.editItems[1][0]._mode} ${S.editItems[1][0]._inplaceError || ''}`);
}

function tinyPng() {
  /* PNG 1x1 blanco */
  return Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
}

console.log('\n' + '='.repeat(52));
console.log(`  ${pass} pruebas correctas · ${fail} fallos`);
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);