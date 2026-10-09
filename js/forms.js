/* ============================================================
   forms.js — Crear y rellenar formularios AcroForm reales.
   ============================================================ */
import { S, $, $$, pageSize, renderPage, toast, status, busy } from './core.js';
import { pageCell } from './layer.js';

let mode = 'create';   // 'create' | 'fill'
let fieldType = 'text';
let activePage = 1;
let overlayBox = null;
let fieldSeq = 0;

export function initForms() {
  $$('.tool[data-ffield]').forEach(b => b.addEventListener('click', () => {
    fieldType = b.dataset.ffield;
    $$('.tool[data-ffield]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    $('#ffDropOpts').style.opacity = (fieldType === 'dropdown' || fieldType === 'radio') ? '1' : '.35';
  }));

  $('#ffCreate').addEventListener('click', () => {
    mode = 'create';
    status('Arrastra sobre la página para colocar el campo');
  });

  $('#ffModeFill').addEventListener('click', () => {
    mode = mode === 'fill' ? 'create' : 'fill';
    $('#ffModeFill').textContent = mode === 'fill' ? 'Terminar de rellenar' : 'Rellenar formulario';
    if (mode === 'fill') {
      // cargar valores existentes si los hay
      loadExistingFields();
    }
    status(mode === 'fill' ? 'Modo rellenar: haz clic en los campos' : 'Modo crear campos');
    mountForms();
  });

  $('#ffRemove').addEventListener('click', () => {
    if (overlayBox && overlayBox._field) {
      const i = S.formFields.indexOf(overlayBox._field);
      if (i >= 0) S.formFields.splice(i, 1);
      overlayBox.remove();
      overlayBox = null;
      toast('Campo eliminado');
      dirty();
    } else toast('Selecciona un campo primero', 'err');
  });
}

function dirty() { window.dispatchEvent(new CustomEvent('pdf-dirty')); }

let existingLoaded = false;

async function loadExistingFields() {
  if (existingLoaded) return;
  existingLoaded = true;
  try {
    const doc = await PDFLib.PDFDocument.load(S.originalBytes, { ignoreEncryption: true });
    const form = doc.getForm();
    for (const f of form.getFields()) {
      const name = f.getName();
      const widgets = f.acroField.getWidgets();
      for (const w of widgets) {
        const r = w.getRectangle();
        const page = findPageOfRect(r, doc);
        if (!page) continue;
        let value = null, checked = false;
        try { if (f.acroField instanceof PDFLib.AcroCheckBox) checked = f.acroField.isChecked(); }
        catch { }
        if (f.acroField && 'getText' in f.acroField) { try { value = f.acroField.getText(); } catch { } }
        S.formValues[name] = value;
        S.formFields.push({
          id: 'ex-' + name + '-' + Math.random().toString(36).slice(2, 6),
          name, page,
          type: f.acroField.constructor.name.replace('Acro', '').replace('Field', '').toLowerCase(),
          x: r.x * 1.35, y: r.y * 1.35, w: r.width * 1.35, h: r.height * 1.35,
          pscale: 1.35, existing: true, checked, value,
        });
      }
    }
    toast(`${S.formFields.length} campo(s) existente(s) cargados`, 'ok');
  } catch (e) { /* no había formulario */ }
}

function findPageOfRect(rect, doc) {
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const { width, height } = pages[i].getSize();
    if (rect.x >= -2 && rect.x <= width + 2 && rect.y >= -2 && rect.y <= height + 2) return i + 1;
  }
  return 1;
}

/* Render de una página con los campos existentes encima */
function fieldOverlay(pageNum, cell) {
  const wrap = cell.querySelector('.canvas-wrap') || cell;
  for (const f of S.formFields) {
    if (f.page !== pageNum) continue;
    const d = document.createElement('div');
    d.className = 'item';
    d.style.cssText = `left:${f.x}px;top:${f.y}px;width:${f.w}px;height:${f.h}px;z-index:5;`;

    if (f.type === 'checkbox' || f.type === 'radio') {
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!f.checked;
      cb.style.cssText = 'width:100%;height:100%;accent-color:#2f81f7;cursor:pointer;background:transparent;border:1px solid #2f81f7;';
      cb.onchange = () => { f.checked = cb.checked; S.formValues[f.name] = cb.checked; dirty(); };
      d.appendChild(cb);
    } else if (f.type === 'dropdown') {
      const sel = document.createElement('select');
      sel.style.cssText = 'width:100%;height:100%;background:#0c0f14ee;border:1px solid #2f81f7;font-size:12px;';
      (f.options || []).forEach(o => {
        const op = document.createElement('option'); op.textContent = o; sel.appendChild(op);
      });
      sel.onchange = () => { f.value = sel.value; S.formValues[f.name] = sel.value; dirty(); };
      d.appendChild(sel);
    } else {
      const inp = document.createElement('input');
      inp.className = 'txt';
      inp.value = f.value || '';
      inp.style.cssText = 'width:100%;height:100%;background:#ffffff10;border:1px dashed #2f81f7;color:#e6edf3;padding:1px 3px;font-size:12px;';
      inp.oninput = () => { f.value = inp.value; S.formValues[f.name] = inp.value; dirty(); };
      d.appendChild(inp);
    }

    const h = document.createElement('div');
    h.className = 'handle'; d.appendChild(h);
    // drag + resize
    d.addEventListener('pointerdown', e => {
      if (e.target.classList.contains('handle')) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, ox = f.x, oy = f.y;
      const mv = ev => { f.x = ox + ev.clientX - sx; f.y = oy + ev.clientY - sy; d.style.left = f.x + 'px'; d.style.top = f.y + 'px'; };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); dirty(); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
    h.addEventListener('pointerdown', e => {
      e.stopPropagation();
      const sx = e.clientX, sy = e.clientY, ow = f.w, oh = f.h;
      const mv = ev => { f.w = Math.max(14, ow + ev.clientX - sx); f.h = Math.max(12, oh + ev.clientY - sy); d.style.width = f.w + 'px'; d.style.height = f.h + 'px'; };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); dirty(); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });

    d.addEventListener('pointerdown', () => {
      $$('.item').forEach(x => x.classList.remove('sel'));
      d.classList.add('sel'); overlayBox = d; d._field = f;
    });
    wrap.appendChild(d);
  }
}

export function mountForms() {
  const cont = $('#pages-forms');
  if (!S.jsDoc) return;
  const n = S.jsDoc.numPages;
  if (cont.childElementCount) return;

  for (let p = 1; p <= n; p++) {
    const cell = pageCell(p, cont);
    const cv = document.createElement('canvas');
    cell.appendChild(cv);
    renderPage(p, cv, 1.35).then(() => fieldOverlay(p, cell));

    // creación por arrastre
    cv.addEventListener('pointerdown', e => {
      if (mode !== 'create') return;
      const r = cv.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const wrap = cell.querySelector('.canvas-wrap');
      const ghost = document.createElement('div');
      ghost.style.cssText = `position:absolute;border:1px dashed #2f81f7;background:#2f81f722;left:${sx}px;top:${sy}px;width:0;height:0;`;
      wrap.appendChild(ghost);
      const mv = ev => {
        const cx = ev.clientX - r.left, cy = ev.clientY - r.top;
        ghost.style.left = Math.min(sx, cx) + 'px'; ghost.style.top = Math.min(sy, cy) + 'px';
        ghost.style.width = Math.abs(cx - sx) + 'px'; ghost.style.height = Math.abs(cy - sy) + 'px';
      };
      const up = ev => {
        removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
        const cx = ev.clientX - r.left, cy = ev.clientY - r.top;
        ghost.remove();
        const x = Math.min(sx, cx), y = Math.min(sy, cy);
        const w = Math.abs(cx - sx), h = Math.abs(cy - sy);
        if (w < 10 || h < 8) return;
        const f = {
          id: 'ff' + (++fieldSeq) + '-' + Math.random().toString(36).slice(2, 6),
          name: suggestName(fieldType),
          type: fieldType, page: p,
          x, y, w, h, pscale: 1.35,
          options: fieldType === 'dropdown' || fieldType === 'radio'
            ? ($('#ffOptions').value || 'Sí').split('|').map(s => s.trim()).filter(Boolean)
            : undefined,
          value: '', checked: false,
        };
        S.formFields.push(f);
        toast(`Campo «${f.name}» creado`, 'ok');
        dirty();
        fieldOverlay(p, cell);
      };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
  }
}

function suggestName(t) {
  const base = { text: 'campo', checkbox: 'casilla', dropdown: 'lista', radio: 'radio' }[t] || 'campo';
  return `${base}_${Date.now().toString(36).slice(-4)}`;
}