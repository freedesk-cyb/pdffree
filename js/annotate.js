/* ============================================================
   annotate.js — Resaltar, tachar, subrayar, dibujar y comentar.
   Cada página tiene su propio lienzo de anotaciones (2D context).
   Al guardar, writer.js los graba como contenido real del PDF.
   ============================================================ */
import { S, $, $$, renderPage, toast, status } from './core.js';
import { pageCell } from './layer.js';

let tool = 'none';
const views = new Map();   // pageNum -> {canvas, ctx, base}

export function initAnnotate() {
  $$('.tool[data-atool]').forEach(b => b.addEventListener('click', () => {
    tool = b.dataset.atool;
    $$('.tool[data-atool]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    status(tool === 'none' ? 'Modo lectura (el PDF original se ve intacto)'
      : `${cap(tool)}: arrastra sobre la página`);
  }));

  $('#aClear').addEventListener('click', () => {
    const sel = [...views.keys()];
    if (!sel.length) return;
    const p = confirmPage();
    if (p == null) return;
    S.annots[p] = [];
    views.get(p).paint();
    toast(`Anotaciones de la página ${p} eliminadas`, 'ok');
    dirty();
  });
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function dirty() { window.dispatchEvent(new CustomEvent('pdf-dirty')); }
function confirmPage() {
  if (views.size === 1) return views.keys().next().value;
  const p = prompt('Número de página a limpiar:');
  return p ? +p : null;
}

/* ------------------------------------------------------------------ */
export function mountAnnotate() {
  const cont = $('#pages-annotate');
  if (!S.jsDoc || cont.childElementCount) return;
  const SCALE = 1.0;
  for (let p = 1; p <= S.jsDoc.numPages; p++) {
    S.annots[p] = S.annots[p] || [];
    const cell = pageCell(p, cont);
    const base = document.createElement('canvas');
    const over = document.createElement('canvas');
    over.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
    const wrap = document.createElement('div');
    wrap.className = 'canvas-wrap';
    wrap.style.cursor = tool === 'none' ? 'default' : 'crosshair';
    wrap.append(base, over);
    cell.appendChild(wrap);

    renderPage(p, base, SCALE).then(() => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      over.width = base.width; over.height = base.height;
      over.style.width = base.style.width; over.style.height = base.style.height;
      const v = {
        canvas: over, ctx: over.getContext('2d'), base, wrap,
        pscale: SCALE * dpr, page: p, paint: null,
      };
      v.paint = () => paint(v);
      views.set(p, v);
      v.paint();
      wire(v);
    });
  }
}

function paint(v) {
  const ctx = v.ctx;
  ctx.clearRect(0, 0, v.canvas.width, v.canvas.height);
  for (const a of S.annots[v.page]) drawAnn(ctx, a, v.pscale);
}

function drawAnn(ctx, a, s) {
  const color = a.color || '#ffe14d';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const x1 = a.x1 * s, y1 = a.y1 * s, x2 = a.x2 * s, y2 = a.y2 * s;

  if (a.type === 'highlight') {
    ctx.globalAlpha = 0.35;
    ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    ctx.globalAlpha = 1;
  } else if (a.type === 'strike') {
    ctx.lineWidth = (a.width || 2) * s;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  } else if (a.type === 'underline') {
    ctx.lineWidth = (a.width || 2) * s;
    const y = Math.max(y1, y2) + 2 * s;
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
  } else if (a.type === 'freehand') {
    ctx.lineWidth = (a.width || 2) * s;
    for (const [ax, ay, bx, by] of a.segs) {
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
  } else if (a.type === 'note') {
    ctx.fillRect(x1, y1, 14 * s, 14 * s);
    ctx.fillStyle = '#000';
    ctx.font = `${10 * s}px sans-serif`;
    ctx.fillText('C', x1 + 4 * s, y1 + 11 * s);
  }
}

function wire(v) {
  const pos = e => {
    const r = v.base.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (v.base.clientWidth / r.width) * v.pscale,
      y: (e.clientY - r.top) * (v.base.clientHeight / r.height) * v.pscale,
    };
  };
  const color = () => $('#aColor').value;
  const width = () => +$('#aWidth').value;

  v.wrap.addEventListener('pointerdown', e => {
    if (tool === 'none') return;
    e.preventDefault();
    const a0 = pos(e);
    const ctx = v.ctx;
    const colorV = color(), wV = width();

    if (tool === 'freehand') {
      const segs = [];
      let last = a0;
      const mv = ev => {
        const q = pos(ev);
        segs.push([last.x, last.y, q.x, q.y]);
        ctx.strokeStyle = colorV; ctx.lineWidth = wV * v.pscale;
        ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        last = q;
      };
      const up = () => {
        removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
        if (segs.length) {
          S.annots[v.page].push({ type: 'freehand', color: colorV, width: wV, segs, pscale: v.pscale });
          dirty();
        }
      };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
      return;
    }

    if (tool === 'note') {
      const note = prompt('Comentario para esta página:');
      if (!note) return;
      const a = { type: 'note', color: colorV, x1: a0.x, y1: a0.y, x2: a0.x + 14, y2: a0.y + 14, pscale: v.pscale, note };
      S.annots[v.page].push(a); v.paint(); dirty();
      toast('Comentario añadido', 'ok');
      return;
    }

    // highlight / strike / underline: arrastrar
    const ghost = { type: tool, color: colorV, width: wV, x1: a0.x, y1: a0.y, x2: a0.x, y2: a0.y, pscale: v.pscale };
    const mv = ev => { ghost.x2 = pos(ev).x; ghost.y2 = pos(ev).y; drawAnn(ctx, ghost, v.pscale); };
    const up = ev => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
      ghost.x2 = pos(ev).x; ghost.y2 = pos(ev).y;
      if (Math.abs(ghost.x2 - ghost.x1) > 3 || Math.abs(ghost.y2 - ghost.y1) > 3) {
        S.annots[v.page].push(ghost); dirty();
      }
      v.paint();
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
}