> **Histórico (v1).** Desde 2026-10-22 manda `DESIGN.md` (sistema v2). Este contrato queda como registro de la dirección original.

---
version: 1
slug: "admin"
primary_target: "admin"
related_targets: []
---

# Consola no-phone

Scope: the admin console of the no-phone secretary (all routes: pulso, memoria, secretario, herramientas, tareas, plus sign-in and tenant admin). Visitor mode: **operate**. Build path: code-led (operate surface).

Audience and job: each tenant owner (and a superadmin who provisions tenants) checks what needs attention, corrects what the secretary remembers, tunes how it behaves, sees if its tools are alive, and pauses or cancels its scheduled tasks. Daily-ish use, at a desk, often late.

Constraints: multi-tenant with login now; secrets never rendered; nothing in the console sends messages or moves money; Spanish rioplatense copy; standard web controls (operate mode: the world lends type, palette, density and one signature move, never the navigation model or controls).

Memorable moment: the pulse queue — what needs you sits frontmost, still and bright; everything else recedes into drifting dust.

Unresolved: model provider; tenant self-service signup (superadmin creates tenants for now).

## Direction contract

THESIS: The console is one worked queue of what the secretary needs from its owner, ranked by depth: the most urgent line sits frontmost, brightest, widest-tracked and dead still; the rest recede into drifting grey dust. It refuses the category default of a sidebar plus a grid of stat cards and panels.

OWN-WORLD: Emissive black void; four dust neutrals (ash #1A1A1A, dust #4A4A4A, frost #7B7B7B, ivory #E6E2D6); one signal amber #FFB000 only for the focused line, primary action and the caret. One bitmap face (Departure Mono) at 14 / 22 / 44. Text rides baselines on an 11px unit; no boxes, rules or dividers, grouping by baseline and space. State is depth: integer depth maps to brightness step, tracking and drift rate. Failure is a reversed glyph cell.

STORY: The owner opens, reads in one line what needs them (a tool down, a task about to fire, a memory the secretary just learned), pulls that line forward, fixes it, and goes back to the queue. When the secretary got something wrong, they open memoria, find the person or place, and correct the fact.

FIRST VIEWPORT: Top bar: wordmark "no-phone" with blinking amber caret, tenant name, standard nav (pulso · memoria · secretario · herramientas · tareas), session menu. Left two thirds: the pulse queue at depth 3→0, front line at 22px with its action. Right third: the signal feed (recent memory, tool and task events with times). Behind everything, three dust fields on a canvas drift at halved rates.

SIGNATURE INTERACTION: pull forward. Hover or focus raises a line one depth step; selecting it pulls its layer forward into a detail plane while the queue drops one step back; the front plane freezes all drift while read; Escape pushes it back.

FORM: catalog world, user-pinned, id: operate-c-cracktro-scroller-queue. seed: 9a1a3ba97f806a7a38e7aaa590718b5d (rolled after the build; world user-pinned, composition kept).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
