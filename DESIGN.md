---
name: no-phone
description: Consola del secretario no-phone. Sistema v2 (2026-10-22) — la consola nocturna, evolucionada: superficies que agrupan, colores de estado con texto y una fuente legible para leer.
colors:
  bg: "#0a0a09"
  s1: "#121210"
  s2: "#1a1a17"
  s3: "#23231f"
  line: "#2a2a25"
  line-2: "#3b3b34"
  line-input: "#6b685e"
  tx: "#ece8dc"
  tx-2: "#b9b5aa"
  tx-3: "#8d8a80"
  tx-off: "#5e5c55"
  signal: "#ffb000"
  signal-ink: "#1c1300"
  ok: "#5fcb8c"
  bad: "#ff7466"
  info: "#79a8ff"
  warn: "#ffa25f"
  wait: "#d7a8ff"
typography:
  brand:
    fontFamily: "Departure Mono, ui-monospace, monospace"
    use: "wordmark, título de página (30/26px), título de panel y de diálogo (18px), números de identidad"
  text:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    sizes: "13 meta · 14 controles · 15 cuerpo · 16-16.5 títulos de fila y tarjeta"
    weights: "400 y 600"
rounded:
  control: "6px"
  surface: "10px"
  float: "14px"
spacing:
  scale: "4 8 12 16 24 32 48"
  control: "40px (44px con el dedo)"
---

# Sistema de diseño: no-phone (v2)

## Por qué cambió

La v1 («Cracktro Scroller Queue») era una sola fuente bitmap, cinco grises y un ámbar, sin cajas ni colores de
estado: el rango se mostraba solo con brillo. Usándola, Goyo dijo que era «todo del mismo color», que «confunde» y
que se sentía como «mucho texto suelto y junto»; los modales no cerraban al tocar afuera y los avisos eran los del
navegador. El 2026-10-22 eligió **evolucionar el mundo** (no tirarlo): se queda el negro, el ámbar como señal y
Departure Mono como voz de la marca; se suman superficies, colores de estado y una fuente pensada para leer.

## Principios (cada uno con su razón)

1. **Una acción primaria por vista**, en ámbar lleno. El resto retrocede: secundario gris con borde, «quiet» sin borde.
   Así siempre se sabe cuál es el paso siguiente.
2. **Agrupar con superficies y espacio.** Una lista es una superficie (`--s1`, radio 10) con filas separadas por una
   línea fina; un bloque de ajustes es un **Panel** (título, para qué sirve, cuerpo y pie con «guardar»). Antes todo
   flotaba sobre el negro y no se sabía qué iba con qué.
3. **Estados con color + texto**, nunca solo color: `chip` con `data-tono` ok (verde) · bad (rojo) · info (azul) ·
   warn (naranja: a medias) · wait (lila: te espera a vos) · off (gris). El ámbar no es un estado: es acción.
4. **Dos fuentes con trabajos distintos.** Departure Mono (bitmap) es la marca: wordmark, títulos de página/panel/
   diálogo. Todo lo que se lee va en Atkinson Hyperlegible Next (diseñada para baja visión: el dueño puede ver poco o
   nada). Los dígitos de identidad (números de teléfono, ids) pueden ir en la bitmap.
5. **Lo que flota cierra como se espera**: `Dialog` (components/ui.tsx) cierra con Esc, tocando afuera y con ×,
   devuelve el foco y en el celu es una hoja que sube desde abajo. Nada de `alert()`/`confirm()`: `confirmar()` para
   lo irreversible (con el botón de peligro en rojo suave y el foco en «cancelar») y `toast()` para avisar; lo
   reversible se hace directo con **deshacer** en el toast (pausar, borrar una regla).
6. **Toda vista que carga datos** tiene cargando (esqueleto), vacío (qué es y cómo se llena) y error (qué pasó y
   cómo seguir, con «reintentar»).
7. **Guardar es explícito y visible**: el botón de guardar se prende solo con cambios, aparece «sin guardar» +
   «descartar», y cerrar la pestaña con cambios avisa.
8. **Celu de verdad**: navegación abajo (5 pestañas con ícono y nombre, al alcance del pulgar), controles de 44 px
   con el dedo, inputs de 16 px (sin zoom de iOS), hover solo con mouse, `100dvh`, safe areas, sin scroll horizontal.
9. **Accesible de oído**: aria-live en lo que cambia solo (estado del chat, avisos), etiquetas en botones de solo
   ícono, textos de fila que se entienden sin ver el color.

## Tokens

Colores de **tipo** (solo memoria; no son estados y siempre van con su nombre al lado), en `styles/memoria.css`:
`--tipo-gente #ece8dc`, `--tipo-grupo #f0a3c4`, `--tipo-lugar #66cfc0`, `--tipo-cuenta #8fb4ff`, `--tipo-otro #8d8a80`.

Ver el frontmatter y `admin/web/src/styles/world.css`. Las superficies suben de claridad con la altura
(`bg` < `s1` < `s2` < `s3`); el texto tiene tres niveles (`tx`, `tx-2`, `tx-3`), todos ≥ 4.5:1 sobre `s2`. El borde
de los campos (`line-input`) cumple 3:1 sobre el fondo. Los nombres viejos (`--void`, `--frost`, `--ivory`,
`--b0..3`) siguen como alias para no romper código viejo; no usarlos en código nuevo.

## Piezas

| Pieza | Dónde | Para qué |
|---|---|---|
| `Dialog`, `toast`, `confirmar`, `UiHost` | `components/ui.tsx` + `styles/ui.css` | diálogo/hoja, avisos, confirmación propia |
| `Panel` | `components/kit.tsx` | bloque de ajustes con pie de guardar |
| `.filas` / `.fila` | `styles/layout.css` | lista agrupada: título + meta · etiqueta · acciones |
| `.chip[data-tono]` | `styles/world.css` | estado con color y texto |
| `.kv` | `styles/layout.css` | pares dato: valor alineados |
| `.plegado` | `styles/layout.css` | lo terminado/viejo, plegado |
| `.switch` | `styles/layout.css` | prender/apagar al toque (reglas) |
| `.avatar` | `styles/ui.css` | iniciales (memoria) |
| chat | `pages/Llamada.tsx` + `styles/chat.css` | burbujas, composer que crece, charlas agrupadas |
| tarjetas de apps | `components/ToolCards.tsx` + `styles/toolcards.css` | WhatsApp/NX/Movilidad con sus colores |

## Chat (lo más usado)

- Mis mensajes: burbuja ámbar oscuro a la derecha. El secretario: texto a la izquierda, sin burbuja (se lee como
  respuesta). Eventos de misión: línea de sistema con etiqueta «misión». Herramientas: tarjetas de la app.
- La caja de texto crece hasta 7 renglones y después scrollea; Enter manda, Mayús+Enter renglón (en el celu, Enter es
  renglón). «llamar» siempre a la vista. Las charlas, agrupadas por hoy/ayer/esta semana/antes, con buscar.
- No se mueve al final si subiste a leer: aparece «ir al final».
- Lo que espera tu respuesta (aprobar envío/transferencia/misión) queda fijo: columna derecha o arriba de la caja.

## Búsqueda y gestos

- **Buscar mientras escribís, siempre.** Filtrar lo que ya está en pantalla es inmediato y sin tildes (`sinTildes`); lo
  que va al servidor espera a que pares (`useDemorado`: 300 ms, o 700 ms si es caro) y descarta respuestas viejas.
  Enter elige el primer resultado, y Esc limpia.
- **Lienzos que se navegan (red):** la rueda acerca anclada al cursor; en el touchpad, dos dedos desplazan y el
  pellizco acerca; el pellizco táctil queda anclado entre los dedos; al soltar un arrastre hay inercia; doble toque en
  el vacío acerca.

## No

- No volver a `alert()`/`confirm()`, ni a modales que no cierran al tocar afuera.
- No usar color sin texto para un estado; no usar ámbar para estados.
- No meter un segundo botón primario en una vista.
- No poner texto que se lee en la fuente bitmap.
- No franjas laterales de color en filas o tarjetas.
