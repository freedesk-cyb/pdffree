/* ============================================================
   load-vendor.mjs — Carga las librerías de /vendor dentro de Node.
   Los bundles UMD asumen un entorno de navegador; aquí se fuerzan
   a tomar la rama CommonJS evaluándolos en un ámbito controlado.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/**
 * Carga un bundle de /vendor en Node.
 *
 * Primero se intenta el camino CommonJS normal, que es el que usan bien
 * estas librerías (fontkit, por ejemplo, necesita sus streams de Node).
 * Solo si el módulo no exporta nada se recurre a evaluarlo en un ámbito
 * propio, para los bundles que solo acceptan el lado del navegador.
 */
export function loadVendor(name) {
  const file = resolve(ROOT, 'vendor', name);
  try {
    const mod = require(file);
    if (mod && Object.keys(mod).length) return mod;
  } catch (e) { /* seguimos con la vía del navegador */ }
  const code = readFileSync(file, 'utf8');
  const mod = { exports: {} };
  const fn = new Function('module', 'exports', 'self', 'window', 'globalThis', 'document', code);
  fn(mod, mod.exports, globalThis, globalThis, globalThis, undefined);
  if (mod.exports && Object.keys(mod.exports).length) return mod.exports;
  /* el UMD pudo haberlo colgado en el objeto global */
  for (const key of ['PDFLib', 'fontkit', 'docx', 'mammoth', 'XLSX']) {
    if (globalThis[key]) return globalThis[key];
  }
  return mod.exports;
}

/** Prepara el entorno mínimo que espera nuestro código de navegador. */
export function stubBrowser() {
  globalThis.window = globalThis.window || { devicePixelRatio: 1, fontkit: undefined };
  const el = () => ({
    style: {}, classList: { add() {}, remove() {}, toggle() {} },
    getContext: () => null, appendChild() {}, remove() {},
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
  });
  globalThis.document = globalThis.document || {
    createElement: el, querySelector: () => null, querySelectorAll: () => [],
    body: { appendChild() {} }, addEventListener() {},
  };
  const lib = loadVendor('cantoo-pdf-lib.min.js');
  globalThis.PDFLib = lib;          // lo espera writer.js como global
  return lib;
}

export function setPDFLib(lib) {
  globalThis.PDFLib = lib;
  return lib;
}