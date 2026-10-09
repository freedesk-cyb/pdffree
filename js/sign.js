/* ============================================================
   sign.js — Firma manuscrita (canvas) e imagen.
   Dibuja, genera PNG transparente y lo coloca en la página.
   ============================================================ */
import { S, $, toast, status, download, baseName, busy, renderPage, pageSize } from './core.js';
import { pageCell } from './layer.js';

let pad, ctx, drawing = false, last = null;
let inkData = null;
let placeMode = false;
const SCALE = 0.6;

export function initSign() {
  $('#sigDraw').addEventListener('click', () => openPad('draw'));
  $('#sigType').addEventListener('click', () => openPad('type'));
  $('#sigImg').addEventListener('click', pickImage);
  $('#sigClear').addEventListener('click', clearPad);
  $('#sigApply').addEventListener('click', applyInk);
}

function openPad(kind) {
  $('#sigPad').classList.remove('hidden');
  $('#sigActions').classList.remove('hidden');
  pad = $('#sigPad');
  resizePad();
  clearPad();

  if (kind === 'type') {
    const name = $('#sigName').value || '';
    const color = $('#sigColor').value;
    if (!name) return toast('Escribe tu nombre en el campo de texto', 'err');
    drawCursiveSignature(name, color);
    status('Firma de texto generada. Puedes seguir dibujando encima.');
  } else {
    status('Dibuja tu firma con el ratón o el dedo');
  }
  wirePad();
}

function resizePad() {
  const r = pad.getBoundingClientRect();
  const prev = ctx ? ctx.getImageData(0, 0, pad.width, pad.height) : null;
  pad.width = r.width * 2;
  pad.height = r.height * 2;
  ctx = pad.getContext('2d');
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (prev) ctx.putImageData(prev, 0, 0);
}

function clearPad() {
  if (!pad) { pad = $('#sigPad'); resizePad(); }
  ctx.clearRect(0, 0, pad.width, pad.height);
  inkData = null;
}

let wired = false;
function wirePad() {
  if (wired) return; wired = true;
  const pos = e => {
    const r = pad.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: (p.clientX - r.left) * (pad.width / r.width), y: (p.clientY - r.top) * (pad.height / r.height) };
  };
  const start = e => { e.preventDefault(); drawing = true; last = pos(e); };
  const move = e => {
    if (!drawing) return; e.preventDefault();
    const p = pos(e);
    ctx.strokeStyle = $('#sigColor').value || '#0b3d91';
    ctx.lineWidth = 3.2;
    ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    last = p;
  };
  const end = () => { drawing = false; };
  pad.addEventListener('pointerdown', start);
  pad.addEventListener('pointermove', move);
  addEventListener('pointerup', end);
  pad.addEventListener('touchstart', start, { passive: false });
  pad.addEventListener('touchmove', move, { passive: false });
}

function drawCursiveSignature(text, color) {
  const w = pad.width, h = pad.height;
  ctx.fillStyle = color;
  ctx.font = `${Math.floor(h * 0.42)}px "Segoe Script","Brush Script MT",cursive,serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w * 0.06, h * 0.52);
}

function pickImage() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onload = () => {
    const f = inp.files[0];
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        openPad('draw');
        const scale = Math.min(pad.width / img.width, pad.height / img.height, 1);
        ctx.drawImage(img, 10, (pad.height - img.height * scale) / 2, img.width * scale, img.height * scale);
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(f);
  };
  inp.click();
}

function applyInk() {
  // recortar a la zona con tinta y generar PNG transparente
  const d = ctx.getImageData(0, 0, pad.width, pad.height).data;
  let minX = pad.width, minY = pad.height, maxX = 0, maxY = 0, any = false;
  for (let y = 0; y < pad.height; y += 2) {
    for (let x = 0; x < pad.width; x += 2) {
      if (d[(y * pad.width + x) * 4 + 3] > 10) {
        any = true;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (!any) return toast('Dibuja la firma primero', 'err');
  const padPx = 12;
  minX = Math.max(0, minX - padPx); minY = Math.max(0, minY - padPx);
  maxX = Math.min(pad.width, maxX + padPx); maxY = Math.min(pad.height, maxY + padPx);
  const w = maxX - minX, h = maxY - minY;

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  out.getContext('2d').drawImage(pad, minX, minY, w, h, 0, 0, w, h);
  inkData = out.toDataURL('image/png');

  placeMode = true;
  $('#sigPad').classList.add('hidden');
  $('#sigActions').classList.add('hidden');
  status('Ahora haz clic en la página donde colocar la firma');
  mountSignPages();
  toast('Haz clic en la página para colocar la firma', 'ok');
}

export function mountSignPages() {
  const cont = $('#pages-sign');
  if (!S.jsDoc) return;
  cont.innerHTML = '';
  for (let p = 1; p <= S.jsDoc.numPages; p++) {
    const cell = pageCell(p, cont);
    const cv = document.createElement('canvas');
    cell.appendChild(cv);
    renderPage(p, cv, SCALE).then(() => {
      cv.style.cursor = placeMode ? 'crosshair' : 'default';
      if (!inkData) return;
      // píxeles de pantalla por unidad PDF (el canvas se muestra escalado por el navegador)
      const pdfW = pageSize(p).width;
      const pscale = (parseFloat(cv.style.width) || cv.clientWidth) / pdfW;

      cv.addEventListener('click', e => {
        if (!placeMode) return;
        const r = cv.getBoundingClientRect();
        const k = cv.clientWidth / r.width;
        const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k;
        const iw = Math.min(190, pdfW * 0.3), ih = iw * 0.38;

        S.inkImages[p] = inkData;
        S.signPlaced = S.signPlaced || {};
        S.signPlaced[p] = { x, y: y - ih / 2, w: iw, h: ih, pscale };

        const wrap = cell.querySelector('.canvas-wrap');
        wrap.querySelectorAll('.signmark').forEach(n => n.remove());
        const mark = document.createElement('div');
        mark.className = 'signmark';
        mark.style.cssText = `position:absolute;left:${x}px;top:${y - ih / 2}px;width:${iw}px;height:${ih}px;`
          + 'border:1px dashed #3fb950;background:#3fb95022;cursor:pointer;';
        const im = document.createElement('img');
        im.src = inkData; im.style.cssText = 'width:100%;height:100%;object-fit:contain;';
        mark.appendChild(im);
        mark.title = 'Clic para recolocar la firma';
        mark.addEventListener('click', ev => {
          ev.stopPropagation();
          const rr = cv.getBoundingClientRect();
          const kk = cv.clientWidth / rr.width;
          const nx = (ev.clientX - rr.left) * kk, ny = (ev.clientY - rr.top) * kk;
          S.signPlaced[p] = { x: nx, y: ny - ih / 2, w: iw, h: ih, pscale };
          mark.style.left = nx + 'px'; mark.style.top = (ny - ih / 2) + 'px';
          window.dispatchEvent(new CustomEvent('pdf-dirty'));
        });
        wrap.appendChild(mark);

        placeMode = false;
        toast(`Firma colocada en la página ${p}`, 'ok');
        window.dispatchEvent(new CustomEvent('pdf-dirty'));
      });
    });
  }
}

/* Firma con timestamp yhash (dato firmado embebido en el PDF) */
export async function signWithMetadata() {
  const bytes = await buildForSign();
  download(bytes, baseName() + '-firmado.pdf');
}
async function buildForSign() { return (await import('./writer.js')).build(); }