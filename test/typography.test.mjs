/* ============================================================
   typography.test.mjs —” Comprueba los dos problemas reportados:
     1. el texto sustituido debe caer en la MISMA línea base
        que el original (antes flotaba ~0.18 em más arriba);
     2. debe conservar el formato: negrita y cursiva reales,
        y ancho equivalente si la fuente era condensada.
   ============================================================ */
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const { stubBrowser } = await import('./load-vendor.mjs');
const PL = stubBrowser();
const pdfjs = await import(pathToFileURL(
  process.env.PDFJS_LEGACY || 'D:/HomeUse/cnv_aibarra/node_modules/pdfjs-dist/legacy/build/pdf.mjs').href);

mkdirSync(resolve(here, 'out'), { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? (pass++, console.log(`  OK   ${n}`)) : (fail++, console.log(`  FAIL ${n} ${x}`)); };

/* --- carga de nuestros módulos --- */
const { S } = await import('../js/core.js');
const { build } = await import('../js/writer.js');

const PAGE_W = 595.28, PAGE_H = 841.89, PAGE_H_TEST = 300, SC = 1.35;

/** Devuelve las líneas de texto de un PDF con su línea base y anchura,
    reagrupando los trozos que emite el motor (igual que el editor). */
async function lines(bytes) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(0), useSystemFonts: true }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const raw = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const tr = pdfjs.Util.transform(vp.transform, it.transform);
    raw.push({
      str: it.str, baseline: vp.height - tr[5], x: tr[4], w: it.width,
      size: Math.abs(it.transform[3]),
      family: (tc.styles[it.fontName] || {}).fontFamily,
    });
  }
  const groups = [];
  for (const it of raw.sort((a, b) => a.baseline - b.baseline || a.x - b.x)) {
    const tol = Math.max(0.7, it.size * 0.3);
    let g = groups.find(x => Math.abs(x.baseline - it.baseline) <= tol);
    if (!g) { g = { ...it, parts: [] }; groups.push(g); }
    g.parts.push(it);
  }
  return groups.map(g => {
    const parts = g.parts.sort((a, b) => a.x - b.x);
    let str = '', cursor = null;
    for (const p of parts) {
      if (cursor !== null && p.x - cursor > p.size * 0.18) str += ' ';
      str += p.str; cursor = p.x + p.w;
    }
    const first = parts[0], last = parts[parts.length - 1];
    return {
      str: str.trim(),
      baseline: g.baseline,
      width: (last.x + last.w) - first.x,
      x: first.x,
      size: g.size,
      family: g.family,
    };
  });
}

/* ============================================================ */
console.log('\n=== 1. Línea base: la posición debe ser exacta ===');
{
  /* PDF con una línea de texto en Times Roman 16 */
  const src = await PL.PDFDocument.create();
  const p = src.addPage([PAGE_W, PAGE_H]);
  const f = await src.embedFont(PL.StandardFonts.TimesRoman);
  const TEXTO = 'Titulo de ejemplo';
  p.drawText(TEXTO, { x: 70, y: 700, size: 16, font: f });
  S.originalBytes = await src.save();
  S.fileName = 'tipo.pdf';
  S.editItems = {}; S.ocrBoxes = {}; S.formFields = [];
  S.inkImages = {}; S.annots = {}; S.signPlaced = {}; S.pageOps = [];

  const antes = await lines(S.originalBytes);
  const orig = antes[0];

  /* Se sustituye siguiendo exactamente lo que hace el editor al pulsar
     una caja de texto detectada: base anclada al borde inferior.        */
  S.editItems = { 1: [
    { kind: 'cover', x: 70 * SC, y: (PAGE_H - 700 - 16) * SC, w: orig.width * SC, h: 16 * SC, color: '#ffffff', pscale: SC },
    { kind: 'text', x: 70 * SC, y: (PAGE_H - 700 - 16) * SC, w: orig.width * SC, h: 16 * SC, pscale: SC,
      baseline: true, text: 'TITULO DE EJEMPLO',
      style: { family: 'serif', size: 16, color: '#000000', align: 'left',
               probe: { text: TEXTO, width: orig.width } } },
  ]};

  const out = await build();
  writeFileSync(resolve(here, 'out/tipografia.pdf'), out);
  const despues = await lines(out);
  const nuevo = despues.find(l => l.str.includes('TITULO'));

  check('el texto sustituido existe', !!nuevo);
  const delta = nuevo ? Math.abs(nuevo.baseline - orig.baseline) : 999;
  check('la linea base coincide con la original (+-0.5 pt)', delta < 0.5, `-> desvio ${delta.toFixed(3)} pt`);

  const antesDelta = 0.18 * 16;   // el error que había antes
  check(`el desvío es menor que el bug anterior (${antesDelta.toFixed(2)} pt)`, delta < antesDelta / 4,
    `→ ${delta.toFixed(3)} pt`);
  check('la línea base sigue dentro de la página', nuevo && nuevo.baseline > 0 && nuevo.baseline < PAGE_H);
}

/* ============================================================ */
console.log('\n=== 2. Negrita y cursiva: variantes reales, no simuladas ===');
{
  const { pickFont } = await import('../js/writer.js');
  const probe = await PL.PDFDocument.create();

  /* Para cada variante real del PDF, medimos su ancho y comprobamos que el
     motor elige ESA variante y no una aproximación.                        */
  for (const [fname, etiqueta] of [
    ['TimesRoman', 'normal'],
    ['TimesRomanBold', 'negrita'],
    ['TimesRomanItalic', 'cursiva'],
    ['TimesRomanBoldItalic', 'negrita cursiva'],
    ['Helvetica', 'Helvetica normal'],
    ['HelveticaBold', 'Helvetica negrita'],
    ['Courier', 'Courier normal'],
  ]) {
    const src = await PL.PDFDocument.create();
    const p = src.addPage([PAGE_W, 300]);
    const f = await src.embedFont(PL.StandardFonts[fname]);
    const TEXTO = 'Muestra de tipografia';
    p.drawText(TEXTO, { x: 50, y: 200, size: 14, font: f });
    const bytes = await src.save();

    const orig = (await lines(bytes))[0];
    const picked = await pickFont(probe, {
      family: orig.family, size: 14,
      probe: { text: TEXTO, width: orig.width },
    });
    check(`«${etiqueta}» → elige ${fname}`, picked.key === fname,
      `→ eligió ${picked.key} (error ${(picked.score * 100).toFixed(1)}%, escala ${picked.hScale.toFixed(3)})`);
    check(`«${etiqueta}» → ancho sin deformar`, Math.abs(picked.hScale - 1) < 0.02,
      `→ escala ${picked.hScale.toFixed(3)}`);
  }

  /* Courier y CourierBold tienen exactamente el mismo avance por carácter,
     así que es matemáticamente imposible distinguirlos midiendo el ancho:
     en ese caso el motor se queda con la normal. */
  {
    const src = await PL.PDFDocument.create();
    const p = src.addPage([PAGE_W, 300]);
    const f = await src.embedFont(PL.StandardFonts.CourierBold);
    const T = 'Muestra de tipografia';
    p.drawText(T, { x: 50, y: 200, size: 14, font: f });
    const orig = (await lines(await src.save()))[0];
    const picked = await pickFont(probe, { family: orig.family, size: 14, probe: { text: T, width: orig.width } });
    check('«Courier negrita» → dentro de la familia monoespaciada',
      picked.key.startsWith('Courier'), `→ eligió ${picked.key}`);
    check('«Courier negrita» → sin deformar la anchura', Math.abs(picked.hScale - 1) < 0.02,
      `→ escala ${picked.hScale.toFixed(3)}`);
  }

  /* Y el resultado es de verdad más ancho en negrita que en normal */
  const medir = async (fname) => {
    const src = await PL.PDFDocument.create();
    const p = src.addPage([PAGE_W, 200]);
    const f = await src.embedFont(PL.StandardFonts[fname]);
    const T = 'Muestra de tipografia';
    p.drawText(T, { x: 50, y: 100, size: 14, font: f });
    const orig = (await lines(await src.save()))[0];
    S.originalBytes = await src.save();
    S.editItems = { 1: [{ kind: 'text', x: 50 * SC, y: 86 * SC, w: 400 * SC, h: 14 * SC,
      pscale: SC, baseline: true, text: 'Texto sustituido',
      style: { family: orig.family, size: 14, color: '#000', probe: { text: T, width: orig.width } } }]};
    const out = await build();
    return (await lines(out)).find(l => l.str.includes('sustituido'))?.width || 0;
  };
  const wNormal = await medir('TimesRoman');
  const wNegrita = await medir('TimesRomanBold');
  check('el texto en negrita ocupa más ancho que en normal (fuente real)',
    wNegrita > wNormal * 1.03, `→ normal ${wNormal.toFixed(1)} vs negrita ${wNegrita.toFixed(1)}`);
}

/* ============================================================ */
console.log('\n=== 3. Fuente condensada: el ancho debe compensarse ===');
{
  /* Simulamos una fuente condensada: el texto original se dibuja con el
     operador Tz al 72%, igual que una Helvetica Narrow. */
  const src = await PL.PDFDocument.create();
  const p = src.addPage([PAGE_W, 300]);
  const f = await src.embedFont(PL.StandardFonts.TimesRomanBold);
  const TEXTO = 'Ingenieria de Sistemas e informatica, con pertenece en desarrollo';
  p.pushOperators(PL.PDFOperator.of('Tz', ['72']));
  p.drawText(TEXTO, { x: 40, y: 200, size: 13, font: f });
  p.pushOperators(PL.PDFOperator.of('Tz', ['100']));
  S.originalBytes = await src.save();

  const orig = (await lines(S.originalBytes))[0];
  /* Texto nuevo algo más corto para poder distinguirlo del original. */
  const nuevoTexto = 'CORREGIDA: Ingenieria de Sistemas, redes y seguridad.';
  /* pdf.js mide la línea base desde ARRIBA: distancia desde el borde superior
     = altura - (posición de la base desde abajo). El borde superior del
     recuadro de texto está una altura de fuente por encima de la base.      */
  const topDesdeArriba = (PAGE_H_TEST - orig.baseline) - 13;

  S.editItems = { 1: [{
    kind: 'cover', x: orig.x * SC, y: (topDesdeArriba - 1) * SC,
    w: orig.width * SC, h: 15 * SC, color: '#ffffff', pscale: SC,
  }, {
    kind: 'text', x: orig.x * SC, y: topDesdeArriba * SC, w: orig.width * SC, h: 13 * SC,
    pscale: SC, baseline: true, text: nuevoTexto,
    style: { family: orig.family, size: 13, color: '#000000',
             probe: { text: TEXTO, width: orig.width } },
  }]};

  const { pickFont } = await import('../js/writer.js');
  const probeDoc = await PL.PDFDocument.create();
  const picked = await pickFont(probeDoc, {
    family: orig.family, size: 13, probe: { text: TEXTO, width: orig.width },
  });
  check('detecta que la línea es más estrecha de lo natural', picked.hScale < 0.85,
    `→ escala ${picked.hScale.toFixed(3)}`);

  /* LIMITACIñ“N CONOCIDA: en un texto condensado, condensar y poner en negrita
     producen el mismo estrechamiento. Con solo el ancho es imposible
     distinguir «Times condensado» de «Times normal estrecho»: gana la fuente
     más estrecha y el peso puede no detectarse. Lo que sí se garantiza es que
     la anchura final sea la del original. */
  check('pertenece a la familia correcta', picked.key.startsWith('Times'),
    `→ ${picked.key} (la negrita puede no detectarse en texto condensado)`);

  const out = await build();
  const resultado = await lines(out);
  const nuevos = resultado.filter(l => l.str.includes('CORREGIDA'));

  check('el texto corregido sale en UNA sola línea', nuevos.length === 1,
    `→ ${resultado.map(l => l.str.slice(0, 24)).join(' | ')}`);

  /* El ancho esperado: el texto nuevo a la misma escala que la línea original.
     (No puede ocupar el ancho absoluto del original: la frase es más corta.) */
  const docT = await PL.PDFDocument.create();
  const ft = await docT.embedFont(PL.StandardFonts[picked.key]);
  const esperado = ft.widthOfTextAtSize(nuevoTexto, 13) * picked.hScale;
  check('el texto conserva la ESCALA de la fuente condensada',
    nuevos[0] && Math.abs(nuevos[0].width - esperado) / esperado < 0.05,
    `→ ${nuevos[0]?.width.toFixed(1)} vs esperado ${esperado.toFixed(1)} (escala ${picked.hScale.toFixed(3)})`);
  check('la línea base coincide exactamente con la original',
    nuevos[0] && Math.abs(nuevos[0].baseline - orig.baseline) < 0.5,
    `→ desvío ${Math.abs((nuevos[0]?.baseline ?? 999) - orig.baseline).toFixed(3)} pt`);
  check('el texto corregido empieza en la misma X que el original',
    nuevos[0] && Math.abs(nuevos[0].x - orig.x) < 0.5,
    `→ ${nuevos[0]?.x.toFixed(2)} vs ${orig.x.toFixed(2)}`);
  check('el texto cabe en la caja original', nuevos[0] && nuevos[0].width <= orig.width * 1.02,
    `→ ${nuevos[0]?.width.toFixed(1)} vs ${orig.width.toFixed(1)}`);
  check('el texto original queda oculto pero sigue en el archivo',
    resultado.some(l => l.str.includes('pertenece')),
    '→ el original permanece en el flujo, tapado: usa Censurar si quieres destruirlo');
}

/* ============================================================ */
console.log('\n=== 4. El color del texto sigue siendo válido ===');
{
  const src = await PL.PDFDocument.create();
  const p = src.addPage([PAGE_W, 200]);
  const f = await src.embedFont(PL.StandardFonts.Helvetica);
  S.originalBytes = await src.save();
  S.editItems = { 1: [{
    kind: 'text', x: 40 * SC, y: 100 * SC, w: 300 * SC, h: 14 * SC, pscale: SC, baseline: true,
    text: 'Texto en color azul',
    style: { family: 'sans-serif', size: 14, color: '#003399' },
  }]};
  const out = await build();
  const raw = String((await PL.PDFDocument.load(out)).getPage(0).node.Contents() || '');
  check('el color se escribe sin valores corruptos (NaN/undefined)',
    !/NaN|undefined/.test(raw), raw.length > 0 ? '' : '→ contenido vacío');
  check('el PDF sigue siendo válido', (await PL.PDFDocument.load(out)).getPageCount() === 1);
}

console.log('\n' + '='.repeat(52));
console.log(`  ${pass} pruebas correctas · ${fail} fallos`);
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);
