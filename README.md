# PDF Free — editor de PDF en el navegador

Un editor de PDF **nivel Acrobat Pro** que funciona entero dentro del navegador.
Sin cuenta, sin suscripción, sin servidor y **sin subir un solo byte a Internet**.

> **Privacidad por diseño.** Todas las librerías están en `/vendor` (37 MB) y se sirven
> desde el propio dominio. La app comprueba al arrancar que no haya ni un `<script>`
> externo y avisa en pantalla si lo detecta. Puedes verificarlo tú mismo: abre las
> DevTools → Network y verás que todo va a tu propio servidor.

---

## Arrancar en 10 segundos

```bash
node serve.mjs          # o:  npm start
```

Abre <http://localhost:8080>. No hace falta instalar nada más: no hay `node_modules`
en tiempo de ejecución, no hay build, no hay base de datos.

También puedes **abrir `index.html` directamente** con doble clic (funciona en
Chrome/Edge/Firefox). La única diferencia es que algunos navegadores limita el OCR
en modo `file://`; si pasa, usa `node serve.mjs`.

---

## Qué hace

| Pestaña | Función |
|---|---|
| **Editar** | Texto nuevo, tapar/borrar texto existente, censura, imágenes. Fuente, tamaño, color, negrita, cursiva y alineación. Fuentes TTF propias. |
| **OCR** | Convierte un PDF escaneado en **buscable y seleccionable** con Tesseract (español, inglés o ambos). Vista del texto reconocido y corregible. |
| **Páginas** | Unir, dividir, rotar, duplicar, eliminar, reordenar arrastrando y extraer rangos (`1-3,7,10-12`). |
| **Formularios** | Crea campos AcroForm **reales**: texto, casilla, botón de radio y desplegable. Se rellenan en Acrobat, Chrome, Edge o móvil. |
| **Firmar** | Firma manuscrita con el ratón o el dedo, firma de texto cursiva o imagen. Recolocable. |
| **Convertir** | PDF → Word, Excel, texto, HTML e imágenes PNG. Word/Excel → PDF. Unir varios PDFs. |
| **Comprimir / Clave** | Compresión por recompresión de imágenes, **cifrado AES-256 real**, quitar contraseña, permisos (imprimir/copiar/modificar) y limpieza de metadatos. |
| **Anotar** | Resaltar, tachar, subrayar, dibujar a mano alzada y comentar. Se graban dentro del PDF. |

### Cómo edita el texto: en el sitio, con la fuente real

Marca **«Mostrar cajas de texto detectados»** (se activa **solo** al subir un PDF que
tenga capa de texto) y haz clic sobre la línea. Aparece un **cuadro de escritura encima
del texto**, con su tamaño y su tipografía: escribes allí mismo, ves el cambio mientras
tecleas y sigues editando después. **No hay diálogos.**

- Una línea con bloques separados (un título a la izquierda y una fecha a la derecha)
  da **cajas independientes**: se edita una sin tocar la otra.
- Si **seleccionas solo una parte** de la frase y escribes encima, se sustituye
  únicamente ese fragmento; el resto de la frase conserva sus propios glifos.
- Para colocar el cursor: `Ctrl+Enter` confirma, `Esc` cancela, y al hacer clic
  fuera se confirma.

### Los cambios se ven al instante, en la propia página

Al confirmar una corrección, la app **vuelve a generar el PDF con todos los cambios
aplicados y repinta la página**. No hay que guardar para ver el resultado: lo que ves
es exactamente el archivo que vas a descargar, con su tipografía original, y el texto
no aparece duplicado.

Encima del documento hay una lista **«Cambios en el documento»**, en orden de páginas,
con cada corrección tal cual queda (~~antes~~ → después) y un botón **Deshacer** por
línea: si te arrepentiste de una, la vuelve a su texto original sin tocar el resto.
`Ctrl+S` descarga el PDF definitivo.

Acrobat reescribe el flujo interno del PDF. Aquí también, pero por una vía distinta:

1. Marca **«Mostrar cajas de texto detectados»**.
2. Haz clic sobre la línea que quieres corregir y escribe el texto nuevo.
3. Al guardar, el motor **busca esa línea dentro del flujo de contenido de la página**,
   localiza el operador que la dibuja y **reescribe únicamente su cadena de texto**.

Como todo lo demás de esa línea se conserva intacto, el resultado usa **la fuente que ya
venía incrustada en el PDF**:

| Se conserva | Porque no se toca |
|---|---|
| La tipografía (condensada, negrita, cursiva, marca) | Es el recurso de fuente `/F1` del propio PDF |
| El tamaño y la altura | Es el mismo operador `Tf` |
| El interletraje y el escalado horizontal | Son los mismos `Tc`, `Tw`, `Tz` |
| La posición exacta | Es la misma matriz `Tm` |
| El color | Es el mismo color de relleno |

**WYSIWYG:** al abrir el editor se extraen del propio PDF los archivos de
fuente incrustados y se registran en el navegador, así que el cuadro de escritura usa
la tipografía real del documento (Arial Narrow condensada, Calibri, una fuente de
marca…). Lo que ves mientras escribes es lo que se guarda.

Para escribir el texto nuevo se traduce cada carácter al **código de glifo que usa esa
fuente**, leyendo el mapa `/ToUnicode` del PDF (y preferidos los códigos que la propia
línea ya usaba). Solo se reescribe la cadena: **el resto del flujo queda byte a byte igual**,
así que es imposible que se rompa otra parte del documento.

**Si el PDF no lo permite** —escaneado sin capa de texto, glifo que no está en el
subconjunto incrustado, flujo que no se puede descomprimir— la app **cae automáticamente**
al método alternativo: tapa la línea con el color del fondo y escribe encima con una de las
14 fuentes estándar, ajustando la anchura. Al guardar te dice qué método se ha usado en
cada línea.

Herramientas de tapado para el resto de casos:

- **Tapar**: cubre una zona con un rectángulo; el texto de debajo se copia al portapapeles.
- **Censurar**: rasteriza la zona, así el contenido original es **irrecuperable**
  (redacción real, no tachón).

---

## Publicarlo gratis (y que siga siendo privado)

Al ser una web estática, cualquiera de estas opciones sirve. **El archivo del
cliente nunca pasa por el servidor del hosting** (que solo entrega HTML y JS).

### Cloudflare Pages (recomendado, sin tarjeta)

```bash
npx wrangler pages deploy . --project-name pdf-free
```

### Netlify

```bash
npx netlify-cli deploy --prod --dir .
```

### GitHub Pages

```bash
git init && git add -A && git commit -m "PDF Free"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/pdf-free.git
git push -u origin main
```

Luego en el repo: **Settings → Pages → Source: main / (root)**.
Si publicas en `usuario.github.io/pdf-free/`, cambia las rutas de `index.html` a
rutas relativas (ya lo son) y en `serve.mjs`/`wrangler` no hace falta nada más.

Los ficheros `_headers` (Netlify/Cloudflare) y `.github/workflows/` ya están
incluidos con las cabeceras de seguridad y el workflow de publicación automática.

---

## Estructura

```
index.html          interfaz (8 pestañas)
app.css             estilos
serve.mjs           servidor estático sin dependencias
js/
  core.js           estado global, carga con pdf.js, geometría, utilidades
  layer.js          capa interactiva: mover / redimensionar / colocar
  writer.js         ★ el corazón: convierte el estado en un PDF real
  edit.js  ocr.js  pages.js  forms.js  sign.js  convert.js  protect.js  annotate.js
  app.js            orquestador, pestañas, guardado, API pública
vendor/             todas las librerías, servidas en local
test/               pruebas automatizadas
```

### `writer.js` es la pieza clave

Cuando guardas, `applyToDoc()` aplica **en este orden**: rotaciones → capa de texto
invisible del OCR → rectángulos de tapado/censura → texto e imágenes editados →
firmas → campos de formulario → anotaciones. Cada cambio se graba en el flujo de
contenido del PDF, no como una capa flotante: por eso el resultado se puede buscar,
copiar y abrir en cualquier otro lector.

### API para scripts

Desde la consola del navegador:

```js
await PDFFree.open(archivoFile)   // abrir un File/Blob
PDFFree.pages()                   // nº de páginas
PDFFree.S.editItems[1]            // estado del editor
await PDFFree.build()             // Uint8Array del PDF resultante
await PDFFree.save()              // descargar
```

---

## Pruebas

```bash
npm test                      # 26 pruebas del motor (Node, sin navegador)
node test/typography.test.mjs # 31 pruebas de posición y formato tipográfico
node test/browser.test.mjs    # 33 pruebas end-to-end en Chrome headless
node test/inplace.test.mjs     # 25 pruebas de edición en sitio con fuentes incrustadas
node test/inline.test.mjs      # 18 pruebas del editor en línea y de fragmentos
node test/same-line.test.mjs   # 14 pruebas: al editar una línea se edita esa, no otra parecida
node test/live.test.mjs        # 13 pruebas: el cambio se ve ya en la página y se puede deshacer
node test/report.test.mjs      # 17 pruebas: conversión a Word y descarga del PDF editado
node test/ancho.test.mjs       # 11 pruebas: un texto más largo sigue en una sola línea
node test/sustitucion.test.mjs # 5 pruebas: si la fuente no trae la letra, el original se borra
node test/duplicados.test.mjs  # 11 pruebas: corregir la misma línea varias veces no duplica
node test/cv-real.test.mjs     # 20 pruebas: curriculum real (tildes, viñeta, años) sin alterar orden ni márgenes
node test/kerning.test.mjs     # 12 pruebas: líneas con kerning (TJ), que se duplicaban
node test/make-cv-real-fixture.mjs   # genera test/fixtures/cv-real.pdf
node test/make-cv-kerning-fixture.mjs # genera test/fixtures/cv-kerning.pdf (líneas con TJ)
node test/visual-inplace.mjs   # comparación visual antes/después (Arial Narrow)
node test/visual-inline.mjs    # captura del editor en línea funcionando
node test/visual-cv.mjs        # captura sobre un PDF tipo curriculum completo
node test/make-cv-fixture.mjs  # genera test/fixtures/cv.pdf (curriculum con frases repetidas)
node test/ocr.test.mjs        # OCR real de un PDF escaneado (~1-2 min)
node test/visual.mjs          # comparación visual antes/después de editar
node test/screenshot.mjs      # capturas de las 8 pestañas
```

Estado actual: **26 + 31 + 33 + 25 + 18 + 14 + 13 + 17 + 11 + 5 + 11 + 20 + 12 + 8 = 244 pruebas, 0 fallos**.

Lo que cubren, entre otras cosas:

- el texto corregido es **realmente extraíble** del PDF generado (se verifica
  releyéndolo con pdf.js, no solo mirando que el archivo exista);
- **al pulsar una línea se edita esa misma línea**, aunque el documento repita la
  misma frase en sitios distintos (se comprueba con un curriculum que repite texto);
- **la corrección se ve en la página sin guardar**: se relee el lienzo y se comprueba
  que el texto nuevo está, que no sale duplicado y que se puede deshacer;
- **el .docx generado es un Word válido** (se abre el ZIP y se comprueba que trae
  `word/document.xml` con los párrafos), y **lleva las correcciones** que se hayan hecho;
- **el PDF descargado se abre con pdf-lib y con pdf.js**, se vuelve a guardar sin
  errores y contiene el texto corregido con el original fuera;
- **el texto corregido TAPA al original de verdad**: si la línea se cambia, la vieja
  desaparece del archivo, no queda debajo tapada;
- **una corrección más larga sigue en una sola línea**: el documento no crece en
  renglones ni al escribir ni en el PDF resultante;
- **corregir la misma línea dos veces no la duplica**: la segunda corrección
  sustituye a la primera, el documento muestra un solo renglón y la lista un solo cambio;
- **una línea dibujada con kerning (`TJ`, como las de Word) se corrige sin repetirse**:
  antes se sustituía solo el primer trozo y el resto de la frase se quedaba detrás,
  por eso aparecía «Int de Sistemas…» y luego la frase entera repetida;
- **con el curriculum real**: tildes, viñeta, párrafo de tres renglones y años a la
  derecha. Al corregir cada línea se comprueba que el texto sale exacto, que la línea
  base y los márgenes no se mueven y que el orden del documento es idéntico;
- **funciona también con PDF cuyo contenido va en un flujo directo** (no como
  referencia): antes esa modificación rompía el archivo y el guardado fallaba;
- **una fuente condensada mantiene su anchura** y no salta de línea;
- **la línea base del texto sustituido coincide con la original** (±0,5 pt) y no se
  desplaza al escribir ni al redimensionar el recuadro;
- **la edición en sitio usa la fuente incrustada real del PDF** (Arial Narrow,
  Calibri, negrita…): se comprueba que el PDF resultante sigue teniendo **una sola
  fuente, la misma**, y que el avance de la línea es el de esa fuente;
- **una fuente condensada mantiene su anchura** y no salta de línea;
- la capa de OCR hace el PDF buscable y **conserva el diseño original**;
- los campos AcroForm se crean con su nombre, valor, casilla marcada y opciones;
- el cifrado **AES-256** genera un PDF que pdf.js rechaza sin clave y acepta con ella;
- las rotaciones se aplican a la página correcta;
- **cero peticiones a servidores externos**.

Las capturas quedan en `test/out/shots/`.

---

## Qué NO hace (y por qué)

Esto es lo que de verdad diferencia esta app de Acrobat Pro. Mejor que descubrirlo
a medias:

| Limitación | Detalle |
|---|---|
| **La edición en sitio no siempre es posible** | Necesita que el texto esté en el flujo de la página (no sirve en PDF escaneados) y que la fuente incrustada tenga el glifo de cada carácter nuevo. Cuando falla, cae automáticamente al método de tapado y te avisa. |
| **Caracteres fuera del subconjunto** | Las fuentes incrustadas en un PDF suelen ser un *subconjunto*: si solo trae las letras que usaba el documento y escribes un símbolo que no estaba, ese carácter no se puede dibujar con esa fuente. La app lo detecta, te lo dice y cae al método de tapado con una fuente estándar. **Truco:** si vas a cambiar muchas palabras con letras nuevas, edita primero una línea cualquiera con ellas para forzar a que se incrusten, o usa una fuente que ya contenga esos caracteres. |
| **Reflow automático** | La línea se sustituye en su sitio; no se recoloca el texto que hay a su alrededor. Si la nueva frase es mucho más larga, se sale de la caja (igual que en Acrobat). |
| **Textos dentro de formas o imágenes** | Si el texto está rotado dentro de un gráfico vectorial, se conserva la rotación (es parte de la matriz), pero no se puede cambiar el tamaño ni la fuente: es contenido de dibujo, no texto. |
| **PDF → Word pierde maquetación** | Se reconstruye el texto línea a línea y se detectan tablas por posición de palabras; se conservan los tamaños y los bloques separados por tabulador (título a la izquierda, fecha a la derecha), pero se pierden gráficos, pies de página, estilos y numeración. Es un volcado de contenido, no una conversión fiel. Para eso necesitas LibreOffice/ONLYOFFICE. |
| **Word → PDF por impresión** | Se abre la vista imprimible del navegador y eliges «Guardar como PDF». Mantiene el formato, pero hay un paso manual. |
| **Comprimir rasteriza** | Al comprimir, cada página se convierte en imagen JPEG. Se ve igual, pero esa página deja de tener texto vectorial: no se puede buscar ni seleccionar en ella. Vuelve a pasar OCR si lo necesitas. |
| **Firma manuscrita, no criptográfica** | La firma es una imagen. Legal en la mayoría de contextos, pero no es un certificado cualificado (eIDAS/QES). Para eso, firma desde un escritorio con un certificado. |
| **Sin colaboración en tiempo real** | Las anotaciones se graban en el PDF y varias personas pueden comentarlo sobre el mismo archivo, pero no hay edición simultánea tipo Google Docs. |
| **No compara versiones** | No hay equivalente a «Comparar» de Acrobat. |
| **Sin preflight / producción gráfica** | No hay CMYK, separations, imposition ni marcas de corte. |
| **Rendimiento** | Por encima de ~300 páginas o ~100 MB la interfaz va lenta: divide el documento en partes con la pestaña *Páginas*. |
| **Fuentes TTF propias** | Al cargar una fuente desde el desplegable se incrusta **completa**, sin recortar: el motor de fuentes que usamos no sabe generar subconjuntos y fallaría. El PDF pesa algo más, pero el texto sale idéntico. |

---

## Alternativas cuando esta app se queda corta

| Si necesitas… | Usa |
|---|---|
| Edición de texto realmente "en su sitio" con reflow | **ONLYOFFICE Desktop Editors** (gratis, open source, local) |
| Maquetación compleja, PDF ↔ Word fiel | **LibreOffice Draw** o `docx2pdf` con Word/LibreOffice |
| Many PDF utilities en una web autoalojada | **Stirling-PDF** (Docker) |
| OCR por lotes de miles de páginas | **OCRmyPDF + Tesseract** desde la línea de comandos |
| Firma digital cualificada | Cualquier editor de escritorio con tu certificado (coste del certificado aparte) |

**No uses nunca** iLovePDF, Smallpdf, Sejda web, PDF24 online ni Adobe Acrobat Online
para documentos confidenciales: suben el archivo a sus servidores.

---

## Créditos y licencias

- [PDF.js](https://mozilla.github.io/pdf.js/) — Mozilla, Apache-2.0
- [cantoo/pdf-lib](https://github.com/cantoo/pdf-lib) —/pdf-lib, MIT
- [Tesseract.js](https://tesseract.projectnaptha.com/) + `tesseract.js-core`, Apache-2.0
- [docx](https://docx.js.org/), Apache-2.0 · [SheetJS](https://sheetjs.com/), Apache-2.0
- [Mammoth](https://mammoth.js.org/), BSD-2-Clause · [fontkit](https://github.com/foliojs/fontkit), MIT
- Datos de idioma Tesseract: `spa.traineddata` (español) y `eng.traineddata` (inglés)

Este proyecto: MIT.