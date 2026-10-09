/* ============================================================
   protect.js — Compresión por recompresión de imágenes,
   cifrado AES-256, quitar contraseña y metadatos.
   ============================================================ */
import { S, $, toast, status, busy, download, baseName, setProgress, pageSize } from './core.js';

export function initProtect() {
  $('#compressRun').addEventListener('click', compress);
  $('#encRun').addEventListener('click', () => encrypt(true));
  $('#decRun').addEventListener('click', () => encrypt(false));
  $('#metaClean').addEventListener('click', cleanMeta);
  $('#metaShow').addEventListener('click', showMeta);
}

/* ------------------------------------------------------------------ */
/* Compresión                                                           */
/* ------------------------------------------------------------------ */
async function compress() {
  busy(true, 'Comprimiendo…');
  const prog = $('#cmpProg');
  try {
    const quality = +$('#imgQuality').value;
    const maxPx = +$('#imgMaxPx').value;
    const doc = await PDFLib.PDFDocument.load(S.originalBytes, { ignoreEncryption: true });
    const n = doc.getPageCount();
    let flattened = 0;
    let rasterBytes = 0;

    for (let i = 0; i < n; i++) {
      status(`Comprimiendo página ${i + 1}/${n}…`);
      setProgress(prog, (i / n) * 100);
      const jsPage = S.jsPages[i];
      if (!jsPage) continue;
      const size = await flattenPage(doc, jsPage, i, quality, maxPx);
      rasterBytes += size;
      flattened++;
    }

    const bytes = await doc.save({ useObjectStreams: true });
    setProgress(prog, 100);

    const origSize = byteLen(S.originalBytes);
    const newSize = byteLen(bytes);
    const pct = origSize ? Math.round((1 - newSize / origSize) * 100) : 0;

    showResult('Compresión', `
      <div class="kv">
        <b>Original</b><span>${fmt(origSize)}</span>
        <b>Comprimido</b><span>${fmt(newSize)}</span>
        <b>Ahorro</b><span>${pct > 0 ? pct + '%' : '0% — ya estaba optimizado'}</span>
        <b>Páginas rasterizadas</b><span>${flattened} de ${n}</span>
        <b>Calidad JPEG</b><span>${Math.round(quality * 100)}%${maxPx ? ` · máx. ${maxPx} px` : ''}</span>
      </div>
      <p class="small muted" style="margin-top:10px">
        Cada página se rasteriza y se vuelve a incrustar como JPEG con la calidad elegida.
        Es el mismo truco que usa el «Reducir tamaño» de Acrobat y funciona muy bien con
        documentos escaneados o con muchas fotos.
        <b>Consecuencia:</b> el texto de esas páginas deja de ser vectorial: se verá igual,
        pero ya no se podrá seleccionar ni buscar dentro de ellas. Si necesitas mantener texto
        buscable, usa un OCR posterior en la pestaña <i>OCR</i>, o baja la calidad en vez de rasterizar.
      </p>`);
    toast(pct > 0 ? `Comprimido: ${pct}% menos (${flattened} páginas)` : `Sin ganancia: ya estaba optimizado (${fmt(rasterBytes)} de imágenes)`, pct > 0 ? 'ok' : '');
    download(bytes, baseName() + '-comprimido.pdf');
  } catch (e) {
    console.error(e);
    toast('Error comprimiendo: ' + e.message, 'err');
  }
  setProgress(prog, null);
  busy(false, 'Listo');
}

/* Aplanado real de una página: nueva página con la imagen renderizada */
async function flattenPage(doc, jsPage, index, quality, maxPx) {
  const { width, height } = doc.getPages()[index].getSize();
  const scale = maxPx ? Math.min(3, maxPx / width) : 2;
  const vp = jsPage.getViewport({ scale });
  const cv = document.createElement('canvas');
  cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
  const ctx = cv.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  await jsPage.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', quality));
  const img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  // borrar contenido y dibujar la imagen
  const page = doc.getPages()[index];
  try { page.node.delete(PDFLib.PDFName.of('Contents')); } catch { }
  page.drawImage(img, { x: 0, y: 0, width, height });
  return blob.size;
}

/* ------------------------------------------------------------------ */
/* Cifrado / descifrado                                                */
/* ------------------------------------------------------------------ */
async function encrypt(doEncrypt) {
  const pw = $('#encPw').value;
  if (!doEncrypt && !S.password && !pw) {
    return toast('Si el PDF tiene contraseña, escríbela aquí para quitarla', 'err');
  }
  busy(true, doEncrypt ? 'Cifrando…' : 'Descifrando…');
  try {
    let bytes = await buildWithEdits(); // respeta los cambios de edición antes de proteger

    if (doEncrypt) {
      const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
      doc.encrypt({
        userPassword: pw,
        ownerPassword: pw + '_owner',
        permissions: {
          printing: $('#permPrint').checked ? 'highResolution' : 'none',
          modifying: $('#permModify').checked,
          copyingContents: $('#permCopy').checked,
          fillingFormFields: true,
          contentAccessibility: true,
        },
      });
      bytes = await doc.save();
      toast('PDF cifrado con AES-256 y descargado', 'ok');
      showResult('Cifrado', `
        <div class="kv">
          <b>Algoritmo</b><span>AES-256 (ISO 32000-2 rev. 6)</span>
          <b>Impresión</b><span>${$('#permPrint').checked ? 'permitida' : 'bloqueada'}</span>
          <b>Copiar texto</b><span>${$('#permCopy').checked ? 'permitido' : 'bloqueado'}</span>
          <b>Modificar</b><span>${$('#permModify').checked ? 'permitido' : 'bloqueado'}</span>
          <b>Contraseña</b><span>${pw}</span>
        </div>`);
      download(bytes, baseName() + '-cifrado.pdf');
    } else {
      const usePw = pw || S.password;
      const doc = await PDFLib.PDFDocument.load(bytes, { password: usePw });
      bytes = await doc.save();
      toast('Contraseña eliminada. El PDF ya está desprotegido.', 'ok');
      download(bytes, baseName() + '-descifrado.pdf');
    }
  } catch (e) {
    console.error(e);
    toast('Error: ' + (e.message || 'contraseña incorrecta'), 'err');
  }
  busy(false, 'Listo');
}

async function buildWithEdits() {
  const { build } = await import('./writer.js');
  return await build();
}

/* ------------------------------------------------------------------ */
/* Metadatos                                                           */
/* ------------------------------------------------------------------ */
async function showMeta() {
  try {
    const doc = await PDFLib.PDFDocument.load(S.originalBytes, { ignoreEncryption: true });
    const m = doc.getTitle() || '(sin título)';
    const a = doc.getAuthor() || '(sin autor)';
    const s = doc.getSubject() || '(sin asunto)';
    const k = doc.getKeywords() || '';
    const p = doc.getProducer() || '';
    const c = doc.getCreator() || '';
    const d = doc.getCreationDate();
    showResult('Metadatos', `<div class="kv">
      <b>Título</b><span>${esc(m)}</span><b>Autor</b><span>${esc(a)}</span>
      <b>Asunto</b><span>${esc(s)}</span><b>Palabras clave</b><span>${esc(k)}</span>
      <b>Productor</b><span>${esc(p)}</span><b>Creador</b><span>${esc(c)}</span>
      <b>Creado</b><span>${d ? d.toISOString().slice(0, 10) : '(sin fecha)'}</span>
      <b>Páginas</b><span>${doc.getPageCount()}</span>
    </div>`);
  } catch (e) { toast('Error: ' + e.message, 'err'); }
}

async function cleanMeta() {
  try {
    const doc = await PDFLib.PDFDocument.load(S.originalBytes, { ignoreEncryption: true });
    doc.setTitle(''); doc.setAuthor(''); doc.setSubject(''); doc.setKeywords([]);
    doc.setProducer(''); doc.setCreator('');
    doc.setCreationDate(new Date());
    doc.setModificationDate(new Date());
    const bytes = await doc.save();
    download(bytes, baseName() + '-limpio.pdf');
    toast('Metadatos eliminados', 'ok');
  } catch (e) { toast('Error: ' + e.message, 'err'); }
}

function showResult(title, html) {
  $('#protOut').innerHTML = `<div class="card"><h3>${title}</h3>${html}</div>`;
}
function esc(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function fmt(n) {
  if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}
function byteLen(x) {
  if (!x) return 0;
  return x.byteLength != null ? x.byteLength : x.length;
}