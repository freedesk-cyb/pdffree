/* ============================================================
   convert.js — PDF → Word / Excel / TXT / HTML / Imágenes
                y Word|Excel → PDF (vía impresión del navegador).
   ============================================================ */
import { S, $, pageSize, getTextBoxes, boxesFromTextContent, getPdfJs, docParaExportar,
  toast, status, busy, download, baseName, renderPage } from './core.js';

/* ------------------------------------------------------------------ */
/* Extracción                                                          */
/* ------------------------------------------------------------------ */
/**
 * Si hay correcciones sin guardar, el texto se saca del PDF YA EDITADO:
 * así el Word/Excel/TXT que se descarga lleva los cambios hechos en el
 * editor, no el texto original.
 */
async function extractPages(withBoxes) {
  const { doc, cerrar, editado } = await docParaExportar();
  const out = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const boxes = withBoxes ? boxesFromTextContent(page, await page.getTextContent()) : [];
      const lines = [];
      const byY = new Map();
      for (const b of boxes) {
        const key = Math.round(b.baseline / 3) * 3; // agrupa por línea base
        if (!byY.has(key)) byY.set(key, []);
        byY.get(key).push(b);
      }
      const keys = [...byY.keys()].sort((a, b) => a - b);
      for (const k of keys) {
        /* un título a la izquierda y una fecha a la derecha son bloques
           separados: se conservan como columnas, no se pegan con un espacio */
        const arr = byY.get(k).sort((a, b) => a.x - b.x);
        const texto = arr.map(x => x.str).join(' ').replace(/\s+/g, ' ').trim();
        if (texto) {
          /* se usan los bloques de cada línea (huecos grandes), no la línea
             entera: así título y fecha no acaban pegados en la exportación */
          const bloques = arr.flatMap(x => (x.blocks?.length ? x.blocks : [{ str: x.str, x: x.x, w: x.w }]));
          lines.push({
            text: texto,
            bloques: bloques.sort((a, b) => a.x - b.x),
            x: arr[0].x,
            y: arr[0].y,
            w: Math.max(...arr.map(x => x.x + x.w)) - arr[0].x,
            size: Math.max(...arr.map(x => x.fontSize || 10)),
            words: arr.map(x => ({ x: x.x, w: x.w, str: x.str })),
          });
        }
      }
      out.push(lines);
    }
  } finally {
    if (cerrar) cerrar();
  }
  if (editado) toast('El archivo incluye las correcciones que has hecho.', 'ok');
  return out;
}

/* Detección simple de tablas: filas con ≥3 columnas x muy alineadas */
function detectTable(lines, maxX) {
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    const cols = columnsOf(ln.words);
    if (cols.length >= 3) {
      const block = [];
      let j = i;
      while (j < lines.length && columnsOf(lines[j].words).length >= 3) { block.push(lines[j]); j++; }
      if (block.length >= 2) {
        const colsN = Math.max(...block.map(b => columnsOf(b.words).length));
        const tops = block.map((b, k) => columnsOf(b.words).length);
        tables.push({ start: i, end: j, rows: block, cols: colsN, minCols: Math.min(...tops) });
        i = j; continue;
      }
    }
    i++;
  }
  return tables;
}

function columnsOf(words) {
  // separa palabras en columnas usando huecos grandes
  if (!words || words.length < 3) return [];
  const gaps = [];
  for (let i = 1; i < words.length; i++) {
    const prevEnd = words[i - 1].x + words[i - 1].w;
    gaps.push({ i, gap: words[i].x - prevEnd });
  }
  const sorted = [...gaps].sort((a, b) => b.gap - a.gap);
  const cut = sorted[0].gap;
  if (cut < 6) return [words];
  let blocks = [], cur = [words[0]];
  for (let i = 1; i < words.length; i++) {
    const prevEnd = words[i - 1].x + words[i - 1].w;
    if (words[i].x - prevEnd > cut * 0.6) { blocks.push(cur); cur = []; }
    cur.push(words[i]);
  }
  blocks.push(cur);
  return blocks;
}

/* ------------------------------------------------------------------ */
/* PDF → DOCX                                                          */
/* ------------------------------------------------------------------ */
async function toWord() {
  busy(true, 'Extrayendo texto…');
  try {
    const pages = await extractPages(true);
    const children = [];
    const useTables = $('#convTables').checked;

    pages.forEach((lines, pi) => {
      if (pi > 0) children.push(new docx.Paragraph({ children: [new docx.PageBreak()] }));
      let tIdx = 0;
      const tables = useTables ? detectTable(lines) : [];

      for (let i = 0; i < lines.length;) {
        const t = tables.find(x => x.start === i);
        if (t) {
          const rows = t.rows.map(r => new docx.TableRow({
            children: columnTexts(r).map(c => new docx.TableCell({
              children: [new docx.Paragraph(c)],
            })),
          }));
          children.push(new docx.Table({ rows, width: { size: 100, type: docx.WidthType.PERCENTAGE } }));
          children.push(new docx.Paragraph({ children: [new docx.Break()] }));
          i = t.end;
          continue;
        }
        const ln = lines[i];
        const size = Math.min(Math.max(Math.round(ln.size), 8), 30);
        const isHeading = size >= 15 && ln.text.length < 80;
        /* título a la izquierda + dato a la derecha = un párrafo con tabulador */
        const enColumnas = (ln.bloques?.length || 0) > 1;
        const tab = new docx.TextRun({ children: [new docx.Tab()], size: size * 2 });
        const runs = enColumnas
          ? ln.bloques.flatMap((b, k) => (k
            ? [tab, new docx.TextRun({ text: b.str, size: size * 2, bold: isHeading })]
            : [new docx.TextRun({ text: b.str, size: size * 2, bold: isHeading })]))
          : [new docx.TextRun({ text: ln.text, size: size * 2, bold: isHeading })];

        children.push(new docx.Paragraph({
          children: runs,
          spacing: { before: isHeading ? 160 : 0, after: isHeading ? 120 : 40 },
          tabStops: enColumnas ? [{ type: docx.TabStopType.RIGHT, position: 9000 }] : undefined,
          alignment: /^\s{2,}/.test(ln.text) ? docx.AlignmentType.LEFT : undefined,
        }));
        i++;
      }
    });

    if (!children.length) children.push(new docx.Paragraph('No se encontró texto (¿PDF escaneado? Ejecuta OCR primero).'));

    /* Esta versión de la librería pide las secciones al construir el
       documento; si se pasan aparte, avisa de que el constructor está vacío. */
    const doc = new docx.Document({
      creator: 'PDF Free',
      title: baseName(),
      description: 'Convertido desde PDF',
      sections: [{ properties: {}, children }],
    });
    const blob = await docx.Packer.toBlob(doc);
    download(blob, baseName() + '.docx');
    toast('Word generado. Maquetación sencilla: revisa columnas y gráficos.', 'ok');
  } catch (e) {
    console.error(e);
    toast('Error al generar Word: ' + e.message, 'err');
  }
  busy(false, 'Listo');
}

function columnTexts(row) {
  const blocks = columnsOf(row.words);
  return blocks.map(b => b.map(x => x.str).join(' ').trim());
}

/* ------------------------------------------------------------------ */
/* PDF → XLSX                                                          */
/* ------------------------------------------------------------------ */
async function toExcel() {
  busy(true, 'Analizando tablas…');
  try {
    const wb = XLSX.utils.book_new();
    let tablesTotal = 0;
    const pages = await extractPages(true);

    for (let pi = 0; pi < pages.length; pi++) {
      const lines = pages[pi];
      if (!lines.length) continue;
      const tables = detectTable(lines);
      if (tables.length) {
        tables.forEach((t, ti) => {
          const data = t.rows.map(r => {
            const cells = columnTexts(r);
            while (cells.length < t.cols) cells.push('');
            return cells.slice(0, t.cols);
          });
          const ws = XLSX.utils.aoa_to_sheet(data);
          const name = `P${pi + 1}_T${ti + 1}`.slice(0, 31);
          XLSX.utils.book_append_sheet(wb, ws, name);
          tablesTotal++;
        });
      } else {
        const data = lines.map(l => [l.text]);
        const ws = XLSX.utils.aoa_to_sheet(data);
        XLSX.utils.book_append_sheet(wb, ws, `P${pi + 1}`.slice(0, 31));
      }
    }
    if (!wb.SheetNames.length) { toast('No hay texto extraíble', 'err'); return; }
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      baseName() + '.xlsx');
    toast(`Excel generado (${tablesTotal} tabla(s) detectadas)`, 'ok');
  } catch (e) {
    console.error(e);
    toast('Error: ' + e.message, 'err');
  }
  busy(false, 'Listo');
}

/* ------------------------------------------------------------------ */
/* PDF → TXT / HTML                                                    */
/* ------------------------------------------------------------------ */
async function toTxt() {
  const pages = await extractPages(true);
  const txt = pages.map((l, i) => `===== Página ${i + 1} =====\n` + l.map(x => x.text).join('\n')).join('\n\n');
  download(new Blob([txt], { type: 'text/plain;charset=utf-8' }), baseName() + '.txt');
  showPreview('Texto extraído', txt);
  toast('Texto descargado', 'ok');
}

async function toHtml() {
  const pages = await extractPages(true);
  const body = pages.map((l, i) =>
    `<h3>Página ${i + 1}</h3>` +
    l.map(x => `<p style="font-size:${Math.min(x.size, 24)}px;margin:2px 0">${escHtml(x.text)}</p>`).join('')
  ).join('\n');
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${escHtml(S.fileName)}</title>
<style>body{font:14px/1.5 system-ui;max-width:800px;margin:40px auto;padding:0 20px}h3{color:#888;font-size:12px;text-transform:uppercase;border-bottom:1px solid #ddd;padding-top:20px}</style></head><body>${body}</body></html>`;
  download(new Blob([html], { type: 'text/html;charset=utf-8' }), baseName() + '.html');
  showPreview('HTML generado (vista previa)', body);
  toast('HTML descargado', 'ok');
}

async function toImages() {
  busy(true, 'Renderizando imágenes…');
  const scale = 2;
  for (let p = 1; p <= S.jsDoc.numPages; p++) {
    const page = S.jsPages[p - 1];
    const vp = page.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = vp.width; cv.height = vp.height;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    cv.toBlob(b => download(b, `${baseName()}-p${String(p).padStart(3, '0')}.png`), 'image/png');
    status(`Imagen ${p}/${S.jsDoc.numPages}`);
    await new Promise(r => setTimeout(r, 250));
  }
  busy(false, 'Listo');
  toast('Imágenes descargadas', 'ok');
}

/* ------------------------------------------------------------------ */
/* Word / Excel → PDF (impresión del navegador)                        */
/* ------------------------------------------------------------------ */
async function docxToPdf(file) {
  busy(true, 'Convirtiendo Word…');
  try {
    const buf = await file.arrayBuffer();
    const { value: html, messages } = await mammoth.convertToHtml({ arrayBuffer: buf });
    printToPdf(html, file.name.replace(/\.\w+$/, ''));
    if (messages.length) console.info('mammoth:', messages.slice(0, 5));
    toast('Se abrirá la vista imprimible: elige «Guardar como PDF».', 'ok');
  } catch (e) { toast('No se pudo leer el .docx: ' + e.message, 'err'); }
  busy(false, 'Listo');
}

async function sheetToPdf(file) {
  busy(true, 'Convirtiendo hoja de cálculo…');
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    let html = '<style>table{border-collapse:collapse;font:12px system-ui}td,th{border:1px solid #bbb;padding:3px 6px}</style>';
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
      html += `<h2>${escHtml(name)}</h2><table>` +
        aoa.map(r => '<tr>' + r.map(c => `<td>${escHtml(String(c ?? ''))}</td>`).join('') + '</tr>').join('') +
        '</table>';
    }
    printToPdf(html, file.name.replace(/\.\w+$/, ''));
  } catch (e) { toast('Error: ' + e.message, 'err'); }
  busy(false, 'Listo');
}

function printToPdf(innerHtml, title) {
  const w = window.open('', '_blank');
  if (!w) return toast('Permite las ventanas emergentes para imprimir', 'err');
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escHtml(title)}</title>
<style>@page{size:A4;margin:14mm}body{font:11pt/1.4 system-ui,sans-serif;margin:0}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #999;padding:4px 6px;font-size:9pt}h2{font-size:12pt;margin:16px 0 6px}
img{max-width:100%}p{margin:3px 0}</style></head><body>${innerHtml}</body></html>`);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 700);
}

/* ------------------------------------------------------------------ */
/* Unir varios PDFs                                                    */
/* ------------------------------------------------------------------ */
async function mergeMany(files) {
  const all = [...files, new File([S.originalBytes], S.fileName, { type: 'application/pdf' })];
  const out = await PDFLib.PDFDocument.create();
  for (const f of all) {
    try {
      const src = await PDFLib.PDFDocument.load(new Uint8Array(await f.arrayBuffer()), { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(p => out.addPage(p));
    } catch (e) { console.warn('omitido', f.name, e.message); }
  }
  download(await out.save(), 'fusionado.pdf');
  toast(`${all.length} PDF unidos`, 'ok');
}

/* ------------------------------------------------------------------ */
function showPreview(title, content) {
  $('#convOut').innerHTML = `<div class="card"><h3>${escHtml(title)}</h3><pre>${escHtml(content.slice(0, 20000))}</pre></div>`;
}
function escHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export function initConvert() {
  $('#toWord').addEventListener('click', toWord);
  $('#toExcel').addEventListener('click', toExcel);
  $('#toTxt').addEventListener('click', toTxt);
  $('#toHtml').addEventListener('click', toHtml);
  $('#toImages').addEventListener('click', toImages);
  $('#fromWord').addEventListener('click', () => $('#docxInput').click());
  $('#docxInput').addEventListener('change', e => e.target.files[0] && docxToPdf(e.target.files[0]));
  $('#fromExcel').addEventListener('click', () => $('#sheetInput').click());
  $('#sheetInput').addEventListener('change', e => e.target.files[0] && sheetToPdf(e.target.files[0]));
  $('#zipInput').addEventListener('click', () => $('#zipInputEl').click());
  $('#zipInputEl').addEventListener('change', e => e.target.files.length && mergeMany([...e.target.files]));
}