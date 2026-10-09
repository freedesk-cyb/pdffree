/* ============================================================
   layer.js — Capa de edición interactiva sobre el canvas de una página.
   Gestiona: render del canvas, items posicionados (texto, rectángulos,
   imágenes, trazos), arrastre, redimensionado y selección.
   Coordenadas de los items en píxeles de pantalla.
   ============================================================ */
import { $, renderPage, pageSize, esc } from './core.js';

let zCounter = 0;

export class Layer {
  /**
   * @param {number} pageNum
   * @param {HTMLElement} host  contenedor donde se inserta la página
   * @param {Array}  items       array vivo de items (se referencia, no se copia)
   * @param {object} opts
   *   scale        escala de render (por defecto 1.35)
   *   tool         'select' | 'text' | 'cover' | 'image' | 'draw' | 'none'
   *   coverColor   color de relleno para rectángulos
   *   onItemAdd(item, pt)
   *   onPick(pt)    clic en página vacía con herramienta de colocación
   *   onChange()
   */
  constructor(pageNum, host, items, opts = {}) {
    this.pageNum = pageNum;
    this.items = items;
    this.opts = opts;
    this.scale = opts.scale || 1.35;
    this.selected = null;

    const box = document.createElement('div');
    box.className = 'canvas-wrap' + (opts.tool && opts.tool !== 'select' && opts.tool !== 'none' ? ' interactive' : '');
    box.dataset.page = String(pageNum);

    this.canvas = document.createElement('canvas');
    this.layer = document.createElement('div');
    this.layer.className = 'layer';
    box.append(this.canvas, this.layer);
    host.appendChild(box);
    this.box = box;

    renderPage(pageNum, this.canvas, this.scale).then(() => {
      this.syncLayerScale();
      this.drawBack();
      this.renderItems();
    });

    this._wire();
    this._onResize = debounce(() => {
      this.syncLayerScale();
      this.renderItems();
    }, 150);
    addEventListener('resize', this._onResize);
  }

  /**
   * El lienzo se estrecha solo cuando la ventana es pequeña (max-width:100%).
   * La capa de edición debe seguir esa misma transformación, o los recuadros
   * acabarían desplazados respecto al texto que señalan.
   */
  syncLayerScale() {
    const cssW = parseFloat(this.canvas.style.width) || this.canvas.clientWidth;
    const real = this.canvas.getBoundingClientRect().width;
    if (!cssW || !real) return;
    const k = real / cssW;
    if (Math.abs(k - 1) < 0.005) {
      this.layer.style.transform = '';
      this.layer.style.width = '';
      this.layer.style.height = '';
    } else {
      this.layer.style.transform = `scale(${k})`;
      this.layer.style.transformOrigin = 'top left';
      this.layer.style.width = (100 / k) + '%';
      this.layer.style.height = (100 / k) + '%';
    }
  }

  destroy() {
    removeEventListener('resize', this._onResize);
    this.box.remove();
  }

  /* fondo: rectángulos tapados/redactados sobre el canvas */
  drawBack() {
    this.layer.querySelectorAll('.back').forEach(n => n.remove());
    for (const it of this.items) {
      if (it.kind !== 'cover' && it.kind !== 'whiteout' && it.kind !== 'redact') continue;
      const d = document.createElement('div');
      d.className = 'back item';
      d.style.cssText = `left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px;`
        + `background:${it.kind === 'redact' ? (it.color || '#000') : (it.color || this.opts.coverColor || '#fff')};`
        + `cursor:move;position:absolute;pointer-events:auto;`
        + (it.kind === 'redact' ? 'filter:blur(2px);' : '');
      d.dataset.id = it.id;
      this.layer.appendChild(d);
      this.bindDrag(d, it);
    }
  }

  renderItems() {
    this.layer.querySelectorAll('.item:not(.back)').forEach(n => n.remove());
    for (const it of this.items) this.renderItem(it);
  }

  renderItem(it) {
    /* lo que ya está volcado en el PDF de fondo no se vuelve a dibujar */
    if (it.oculto) return;
    if (it.kind === 'cover' || it.kind === 'whiteout' || it.kind === 'redact') return; // ya en drawBack
    const d = document.createElement('div');
    d.className = 'item';
    d.dataset.kind = it.kind;
    d.dataset.id = it.id;
    d.style.cssText = `left:${it.x}px;top:${it.y}px;width:${Math.max(it.w, 8)}px;height:${Math.max(it.h, 10)}px;z-index:${++zCounter}`;

    if (it.kind === 'text') {
      d.dataset.editing = it.editing ? '1' : '0';
      const ta = document.createElement('textarea');
      ta.value = it.text || '';
      ta.spellcheck = false;
      applyTextStyle(ta, it);
      ta.addEventListener('input', () => {
        it.text = ta.value;
        this.autoGrow(ta, it);
        this.opts.onChange && this.opts.onChange(it);
      });
      ta.addEventListener('pointerdown', e => e.stopPropagation());
      d.appendChild(ta);
      this.layer.appendChild(d);
      d._ta = ta;
      this.bindDrag(d, it, { grow: true });
      this.autoGrow(ta, it);
      if (this.selected === it) d.classList.add('sel');
      return;
    }

    if (it.kind === 'image') {
      const img = document.createElement('img');
      img.src = it.src;
      img.draggable = false;
      img.style.cssText = 'width:100%;height:100%;object-fit:fill;display:block;pointer-events:none;';
      d.appendChild(img);
      this.layer.appendChild(d);
      this.bindDrag(d, it);
      if (this.selected === it) d.classList.add('sel');
      return;
    }

    if (it.kind === 'ink') {
      const c = document.createElement('canvas');
      const w = Math.round(it.w), h = Math.round(it.h);
      c.width = w; c.height = h;
      c.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;';
      const ctx = c.getContext('2d');
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = it.color || '#ffe14d';
      ctx.lineWidth = it.width || 3;
      for (const seg of it.segs) {
        ctx.beginPath(); ctx.moveTo(seg[0], seg[1]); ctx.lineTo(seg[2], seg[3]); ctx.stroke();
      }
      d.appendChild(c);
      this.layer.appendChild(d);
      if (this.selected === it) d.classList.add('sel');
      return;
    }
  }

  /**
   * Ajusta la altura visual del área de escritura al texto que hay dentro.
   *
   * OJO: no toca `it.h`. La altura del elemento es la caja del PDF, y su
   * borde inferior es la línea base del texto: si se modificara al escribir,
   * el texto guardado se desplazaría hacia abajo cada vez que el usuario
   * teclea. El área de escritura simplemente se desborda visualmente.
   */
  autoGrow(ta, it) {
    /* Al corregir una línea existente, el área de escritura crece a lo ANCHO
       para que el texto nuevo quepa en una sola línea, en vez de partirse y
       parecer que se ha añadido una línea nueva. */
    if (it.inplace) {
      ta.style.height = 'auto';
      const w = Math.max(ta.scrollWidth + 8, it.w);
      const alto = Math.max(ta.scrollHeight, 14);
      ta.style.height = alto + 'px';
      const d = ta.closest('.item');
      if (d) d.style.width = w + 'px';
      if (it.baseline) {
        ta.style.position = 'absolute';
        ta.style.bottom = '0';
        ta.style.top = 'auto';
      }
      return;
    }
    ta.style.height = 'auto';
    const h = Math.max(ta.scrollHeight, 14);
    ta.style.height = h + 'px';
    /* Si el texto viene anclado a una línea base, se grows hacia arriba. */
    if (it.baseline) {
      ta.style.position = 'absolute';
      ta.style.bottom = '0';
      ta.style.top = 'auto';
    }
  }

  add(it, focus = false) {
    it.id = it.id || 'i' + Date.now() + Math.random().toString(36).slice(2, 7);
    this.items.push(it);
    this.drawBack();
    this.renderItem(it);
    if (focus) {
      const node = this.layer.querySelector(`.item[data-id="${it.id}"]`);
      if (node && node._ta) { this.select(it); node._ta.focus(); }
      else this.select(it);
    }
    this.opts.onItemAdd && this.opts.onItemAdd(it);
    this.opts.onChange && this.opts.onChange(it);
  }

  select(it) {
    this.selected = it;
    this.layer.querySelectorAll('.item').forEach(n => n.classList.remove('sel'));
    if (it) {
      const n = this.layer.querySelector(`.item[data-id="${it.id}"]`);
      if (n) n.classList.add('sel');
    }
  }

  remove(it) {
    const i = this.items.indexOf(it);
    if (i >= 0) this.items.splice(i, 1);
    if (this.selected === it) this.selected = null;
    const n = this.layer.querySelector(`.item[data-id="${it.id}"]`);
    if (n) n.remove();
    this.opts.onChange && this.opts.onChange(it);
  }

  clear() { this.items.length = 0; this.drawBack(); this.renderItems(); }

  /* ------------------------------------------------ interacción */
  _wire() {
    const { layer, canvas } = this;
    layer.addEventListener('pointerdown', e => {
      if (e.target === layer || e.target === canvas) {
        const tool = this.opts.tool || 'select';
        if (tool !== 'select' && tool !== 'none') {
          this._startDraw(e);
        } else {
          this.select(null);
          if (this.opts.onPick) {
            const pt = this._pt(e);
            this.opts.onPick(pt, this);
          }
        }
      }
    });
  }

  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (this.canvas.clientWidth / r.width),
      y: (e.clientY - r.top) * (this.canvas.clientHeight / r.height),
    };
  }

  _startDraw(e) {
    const tool = this.opts.tool;
    const p0 = this._pt(e);
    const ghost = document.createElement('div');
    ghost.style.cssText = `position:absolute;border:1px dashed #2f81f7;background:#2f81f722;left:${p0.x}px;top:${p0.y}px;width:0;height:0;pointer-events:none;`;
    this.layer.appendChild(ghost);
    const move = ev => {
      const p = this._pt(ev);
      ghost.style.left = Math.min(p0.x, p.x) + 'px';
      ghost.style.top = Math.min(p0.y, p.y) + 'px';
      ghost.style.width = Math.abs(p.x - p0.x) + 'px';
      ghost.style.height = Math.abs(p.y - p0.y) + 'px';
    };
    const up = ev => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      ghost.remove();
      const p = this._pt(ev);
      const rect = norm(p0, p);
      if (rect.w < 4 || rect.h < 4) {
        if (this.opts.onPick) this.opts.onPick(p, this);
        return;
      }
      this.commitDraw(tool, rect);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  commitDraw(tool, rect) {
    if (tool === 'cover' || tool === 'whiteout' || tool === 'redact') {
      this.add({ kind: tool, ...rect, color: this.opts.coverColor || '#ffffff' }, false);
    } else if (tool === 'text') {
      this.add({ kind: 'text', ...rect, text: '', style: this.opts.textStyle ? { ...this.opts.textStyle } : {} }, true);
    } else if (tool === 'image') {
      this.add({ kind: 'image', ...rect, src: this.opts.pendingImage || '' }, true);
    }
  }

  /* ------------------------------------------------ arrastre */
  bindDrag(node, it, { grow = false } = {}) {
    const parent = this.layer;

    node.addEventListener('pointerdown', e => {
      if (e.target.classList && e.target.classList.contains('handle')) return;
      if (e.target.tagName === 'TEXTAREA' && !e.shiftKey) { this.select(it); return; }
      e.stopPropagation();
      this.select(it);
      const start = this._pt(e);
      const o = { x: it.x, y: it.y };
      const move = ev => {
        const p = this._pt(ev);
        it.x = o.x + (p.x - start.x);
        it.y = o.y + (p.y - start.y);
        node.style.left = it.x + 'px';
        node.style.top = it.y + 'px';
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        this.opts.onChange && this.opts.onChange(it);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });

    const h = document.createElement('div');
    h.className = 'handle';
    node.appendChild(h);
    h.addEventListener('pointerdown', e => {
      e.stopPropagation(); e.preventDefault();
      const start = this._pt(e);
      const o = { w: it.w, h: it.h };
      const ratio = it.kind === 'image' ? it.w / it.h : 0;
      const move = ev => {
        const p = this._pt(ev);
        if (ratio && !ev.shiftKey) {
          it.w = Math.max(16, o.w + (p.x - start.x));
          it.h = it.w / ratio;
        } else {
          it.w = Math.max(16, o.w + (p.x - start.x));
          const newH = Math.max(10, o.h + (p.y - start.y));
          /* Si la caja está anclada a una línea base, el borde inferior no
             se mueve: si no, el texto se desplazaría al cambiar el alto. */
          if (it.baseline) it.y += o.h - newH;
          it.h = newH;
        }
        node.style.width = it.w + 'px';
        node.style.height = it.h + 'px';
        node.style.top = it.y + 'px';
        if (grow && it._ta) applyTextStyle(it._ta, it);
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        if (grow && it._ta) this.autoGrow(it._ta, it);
        this.opts.onChange && this.opts.onChange(it);
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
  }
}

function norm(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function cssFont(name) {
  const map = {
    Helvetica: 'Helvetica, Arial, sans-serif',
    'Times-Roman': '"Times New Roman", Times, serif',
    Courier: '"Courier New", monospace',
    Symbol: 'Symbol',
    'ZapfDingbats': 'ZapfDingbats',
  };
  return map[name] || 'Helvetica, Arial, sans-serif';
}

/** Familia CSS a partir de la clave de fuente estándar elegida. */
function familyOf(key = 'Helvetica') {
  if (/^Times/.test(key)) return '"Times New Roman", Times, serif';
  if (/^Courier/.test(key)) return '"Courier New", monospace';
  return 'Helvetica, Arial, sans-serif';
}

/**
 * Pinta el texto en el lienzo con el mismo tamaño y fuente que se usarán al
 * guardar, para que lo que ves sea lo que sale.
 */
export function applyTextStyle(el, it) {
  const st = it.style || {};
  const key = st.font || (/serif/.test(st.family || '') ? 'Times-Roman' : 'Helvetica');
  el.style.fontSize = (st.size || 12) * 1.34 + 'px';
  /* Si el PDF trae su fuente incrustada, se usa para que el texto se vea
     en el editor tal cual sale al guardar (Arial Narrow, Calibri…). */
  const fallback = familyOf(key);
  el.style.fontFamily = st.pdfFont ? `'${st.pdfFont}', ${fallback}` : fallback;
  el.style.textAlign = st.align || 'left';
  el.style.color = st.color || '#000';
  el.style.fontWeight = /Bold/.test(key) || st.bold ? '700' : '400';
  el.style.fontStyle = /Italic|Oblique/.test(key) || st.italic ? 'italic' : 'normal';
  /*Si el original era condensado, se estrecha igual para no desbordar */
  if (st.hScale && Math.abs(st.hScale - 1) > 0.01) {
    el.style.transform = `scaleX(${st.hScale})`;
    el.style.transformOrigin = 'left top';
    el.style.width = (100 / st.hScale) + '%';
  }
}

/* Crea la celda de página con su número, y devuelve el host */
export function pageCell(pageNum, container, extraClass = '') {
  const cell = document.createElement('div');
  cell.className = 'page ' + extraClass;
  cell.dataset.page = String(pageNum);
  const num = document.createElement('span');
  num.className = 'pnum';
  num.textContent = 'pág. ' + pageNum;
  cell.appendChild(num);
  container.appendChild(cell);
  return cell;
}