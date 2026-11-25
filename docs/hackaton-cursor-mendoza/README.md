# Presentación — Cursor Hackatón Mendoza (Grupo 7)

- **Presentación en vivo:** https://claude.ai/artifact/G9uacfaMXFfSnjsiXnquDB (privada: compartir desde el menú Compartir; se descarga como PowerPoint o PDF).
- **Fuente:** `deck.json` (índice: orden, secciones y fuentes) + `slides/<id>.html` (una slide por archivo, con notas del orador en `<aside>`). `termux-prendido.png` es la captura real usada en la slide del interruptor.
- **Estilo:** el de la consola (sistema v2 de `DESIGN.md`): negro `#0a0a09`, ámbar `#ffb000` como único acento, Departure Mono en títulos y Atkinson Hyperlegible Next en el texto (las de `admin/web/public/fonts`), chips de estado.
- Las capturas de chat son **simuladas con datos ficticios**: Naranja X bloquea las capturas de pantalla (FLAG_SECURE, salen negras).

## Pitch

no-phone = seguir conectado sin quedar enredado en el celular. Un secretario con IA usa tu celular real por vos (WhatsApp, colectivos, Naranja X) y le hablás por texto, voz y, como próximo paso, SMS o llamada desde un celu con tapita. Foco, en este orden: personas con discapacidad, personas mayores, adicción al celular, chicos.

## Slides

| # | id | Contenido |
|---|---|---|
| 1 | cover | Portada: NO-PHONE_ · «Conectado, sin quedar enredado.» |
| 2 | problema | El celular no es para todos: discapacidad, mayores (destacados), adicción, chicos |
| 3 | enredo | Adicción: «entrás a ver un mensaje…» con notificaciones animadas |
| 4 | idea | Le hablás a tu secretario, él usa tu celu (slide ámbar) |
| 5 | canales | Texto y voz (hoy), SMS y tapita (próximo paso) |
| 6 | demo | Charla simulada: mamá → respuesta → transferencia con confirmación |
| 7 | quienes | Para quién, mismo orden que el problema |
| 8 | como | Pedís → Entiende → Hace; por qué celu real y no emulador |
| 9 | peas | El agente en PEAS |
| 10 | clasificacion | Lente racional, IA débil/ANI, basado en objetivos, híbrido; propiedades del entorno |
| 11 | gobernanza | Riesgo → cómo lo gobernamos («La IA propone. La persona decide.») |
| 12 | seguro | Cinco garantías de seguridad |
| 13 | interruptor | Captura real de Termux, prendido/apagado |
| 14 | hoy | Lo que ya funciona + 24 s saldo / 4G (medido 2026-11-04) |
| 15 | cierre | Cursor Hackatón Mendoza · Grupo 7 |

## División de la exposición (3 personas)

| Quién | Slides | Bloque |
|---|---|---|
| Persona 1 | 1–5 | El problema y la idea |
| Persona 2 | 6–10 | Cómo funciona por dentro (demo, PEAS, tipo de IA) |
| Persona 3 | 11–15 | Gobernanza, seguridad, resultados y cierre |

Pases: 1→2 «…y ahora les mostramos cómo se ve usarlo»; 2→3 «…una IA con tu celular asusta, así que les contamos cómo la controlamos».

Ojo en preguntas: los PIN no pasan por el modelo y los audios se transcriben en el servidor propio, pero el texto de la charla sí va a un modelo externo (OpenRouter).
