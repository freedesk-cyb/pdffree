/* ============================================================
   cambios.js — Lista de cambios aplicados, en orden de documento.
   Muestra cada línea corregida (página, antes y después), permite
   deshacerla una a una y volver al original.
   ============================================================ */
import { S, $, toast } from './core.js';

let alCambiar = null;
let quitarCambio = null;

/** Se avisa a la app para que repinte la página al deshacer. */
export function onListaCambia(fn) { alCambiar = fn; }

/** El editor registra cómo quitar un cambio y volver a pintar. */
export function onQuitar(fn) { quitarCambio = fn; }

/** Recoge todos los cambios de todas las páginas, ordenados como el documento. */
export function cambiosOrdenados() {
  const out = [];
  for (const p of Object.keys(S.editItems)) {
    const pagina = +p;
    for (const it of S.editItems[pagina] || []) {
      if (it.kind === 'text' && (it.text || '').trim()) {
        out.push({ pagina, it, y: it.y / (it.pscale || 1.35) });
      }
    }
  }
  return out.sort((a, b) => a.pagina - b.pagina || a.y - b.y);
}

export function actualizarPanelCambios() {
  const panel = $('#panelCambios');
  const lista = $('#cambiosLista');
  if (!panel || !lista) return;

  const cambios = cambiosOrdenados();
  panel.classList.toggle('hidden', cambios.length === 0);
  $('#cambiosInfo').textContent = cambios.length
    ? `${cambios.length} ${cambios.length === 1 ? 'cambio' : 'cambios'} · se ve ya en la página`
    : '';

  lista.innerHTML = '';
  let ultimoNum = -1;
  for (const { pagina, it } of cambios) {
    if (pagina !== ultimoNum) {
      ultimoNum = pagina;
      const h = document.createElement('li');
      h.className = 'cambios-pag';
      h.textContent = `Página ${pagina}`;
      lista.appendChild(h);
    }
    const li = document.createElement('li');
    li.className = 'cambio' + (it.applied ? ' aplicado' : '');

    const txt = document.createElement('div');
    txt.className = 'cambio-txt';
    txt.innerHTML = `<span class="antes">${esc(it.original || '')}</span>`
      + `<span class="flecha">&rarr;</span>`
      + `<span class="despues">${esc(it.text)}</span>`;
    li.appendChild(txt);

    const b = document.createElement('button');
    b.className = 'btn sm';
    b.textContent = 'Deshacer';
    b.title = 'Volver al texto original de esta línea';
    b.onclick = () => deshacer(pagina, it, quitarCambio);
    li.appendChild(b);
    lista.appendChild(li);
  }
}

/** Quita el cambio y vuelve a pintar la página con el texto original. */
async function deshacer(pagina, it, quitar) {
  if (quitar) quitar(pagina, it);
  toast('Cambio deshecho');
  actualizarPanelCambios();
  if (alCambiar) await alCambiar(pagina);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function initCambios() {
  const cerrar = $('#cerrarCambios');
  if (cerrar) cerrar.onclick = () => $('#panelCambios').classList.add('cerrado');
  actualizarPanelCambios();
}