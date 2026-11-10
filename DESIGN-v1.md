<!-- HISTORIA: sistema v1 («Cracktro Scroller Queue»), reemplazado el 2026-10-22 por DESIGN.md (v2). No es la fuente. -->
---
name: no-phone
description: Consola de la secretaria no-phone. Una cola de trabajo ordenada por profundidad sobre vacío negro.
colors:
  void: "#000000"
  ash: "#1a1a1a"
  dust: "#4a4a4a"
  frost: "#7b7b7b"
  ivory: "#e6e2d6"
  signal: "#ffb000"
  depth-0: "#7b7b7b"
  depth-1: "#a19e97"
  depth-2: "#c6c2b8"
  depth-3: "#e6e2d6"
typography:
  display:
    fontFamily: "Departure Mono, ui-monospace, monospace"
    fontSize: "44px"
    fontWeight: 400
    lineHeight: "55px"
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Departure Mono, ui-monospace, monospace"
    fontSize: "22px"
    fontWeight: 400
    lineHeight: "33px"
    letterSpacing: "0.07em"
  body:
    fontFamily: "Departure Mono, ui-monospace, monospace"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "22px"
    letterSpacing: "0em"
    fontFeature: "tnum"
rounded:
  none: "0px"
spacing:
  unit: "11px"
  line: "22px"
  control: "33px"
  gutter: "44px"
  gutter-narrow: "16px"
  indent: "3ch"
components:
  button:
    backgroundColor: "transparent"
    textColor: "{colors.ivory}"
    rounded: "{rounded.none}"
    padding: "0 1.4ch"
    height: "33px"
  button-primary:
    backgroundColor: "transparent"
    textColor: "{colors.signal}"
    rounded: "{rounded.none}"
    padding: "0 1.4ch"
    height: "33px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ivory}"
    rounded: "{rounded.none}"
    padding: "0 0.6ch"
    height: "33px"
  button-disabled:
    backgroundColor: "transparent"
    textColor: "{colors.dust}"
    rounded: "{rounded.none}"
  input:
    backgroundColor: "{colors.void}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.none}"
    padding: "5px 1.2ch 5px 1.6ch"
    height: "33px"
  scale-step:
    backgroundColor: "transparent"
    textColor: "{colors.frost}"
    rounded: "{rounded.none}"
    size: "33px"
  scale-step-on:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.void}"
    rounded: "{rounded.none}"
    size: "33px"
  reversed-cell:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.void}"
    rounded: "{rounded.none}"
    padding: "0 0.3em"
  nav-link:
    textColor: "{colors.depth-0}"
    height: "44px"
  nav-link-active:
    textColor: "{colors.ivory}"
    height: "44px"
  queue-line-front:
    textColor: "{colors.depth-3}"
    typography: "{typography.title}"
---

# Design System: no-phone

## Overview

**Creative North Star: "The Cracktro Scroller Queue"**

The console is one worked queue of what the secretary needs from its owner, laid on an emissive black void and ranked by depth. The line that needs you sits frontmost: brightest, widest-tracked, largest and dead still. Everything else recedes a step at a time into grey, and behind the work three fields of grey dust drift sideways like a demo-scene scroller. It is an operate surface: the world lends type, palette, density and one signature move (pull forward), never the navigation model or the controls, which stay standard web controls dressed in the world's glyphs.

Density is that of a terminal read late at night: one bitmap face at three sizes, text riding 22px baselines on an 11px unit, grouping by baseline and space instead of boxes, rules or cards. Rank is never a badge or a color code; it is integer depth mapped to brightness, tracking and drift. Failure is a reversed glyph cell, never a red.

The system refuses the category default of a sidebar plus a grid of stat cards and panels.

**Key Characteristics:**
- One bitmap face (Departure Mono) at 14 / 22 / 44, unsmoothed, tabular numerals.
- Five neutrals on pure black plus one signal amber held to a handful of marks.
- State is depth: 0 to 3 maps to brightness step, letter-spacing and drift rate.
- No containers: no cards, no side stripes, no dividers, zero radius everywhere.
- Glyph heads (">", "·", "[x]") stand in for bullets, radios and checkboxes.
- A canvas of drifting dust behind the work, frozen whenever a plane is pulled forward.

## Colors

Pure black with four dust neutrals and a single phosphor amber; the neutral ramp does the ranking, the amber only points.

### Primary
- **Phosphor Amber** (signal): the caret that blinks after the wordmark and after loading lines, the mark of the front (depth 3) queue line, and one primary action per view. Transiently it is also the focus ring, the text selection, the hover head of a button and the busy crawl. Nothing else at rest.

### Neutral
- **Emissive Void** (void): every background, including the fill of a pulled-forward plane and of inputs.
- **Ash** (ash): the frame of a disabled button; the darkest visible step.
- **Dust** (dust): hairline frames of buttons, inputs and scale steps; leader dots; the marks of depth 0 and 1 lines; scrollbar; disabled text.
- **Frost** (frost): metadata, labels, hints, times, unchecked glyph heads, and the dust motes themselves (painted at 50 to 62% alpha).
- **Ivory** (ivory): titles, display, input text, selected choices, checked toggles, the selected scale step fill and the reversed failure cell.
- **Depth ramp** (depth-0 to depth-3): the four text brightnesses a ranked line can take, back to front. Every step holds at least 4.5:1 on the void.

### Named Rules
**The Amber Budget Rule.** At rest, amber appears only on the caret (wordmark, waiting lines, and the "> " head of the active nav link or tab), the front line's mark and one primary action per view. Selected choices, checked toggles and the chosen scale step are ivory, never amber.

**The Reversed Cell Rule.** Failure, a down tool and a missing secret render as a reversed glyph cell: ivory ground, void glyph ("!" or "falta"). There is no red in the system.

**The Depth Is Rank Rule.** Importance is shown only by depth (brightness, tracking, size at the front). Never by a colored badge, pill or tinted row.

## Typography

**Display Font:** Departure Mono (with ui-monospace, monospace)
**Body Font:** Departure Mono
**Label/Mono Font:** Departure Mono

**Character:** A single pixel-grid face, rendered with smoothing off and tabular numerals, so every line reads like a cracktro scroller set in one machine font. Hierarchy comes from three sizes and from tracking, never from weight (everything is 400).

### Hierarchy
- **Display** (400, 44px, 55px line, -0.01em; 33px under 720px): the page statement that ends in a period ("2 cosas te necesitan.", "secretario."). One per page, balanced wrap.
- **Title** (400, 22px, 33px line): section heads, the front queue line, device names, the wordmark (tracked 0.07em there and on the front line).
- **Body** (400, 14px, 22px line): everything else, including labels, metadata, inputs and buttons. Explanatory text holds to 64ch, details to 88ch.

### Named Rules
**The One Face Rule.** Departure Mono at 14, 22 and 44 only. No second family, no bold, no italics; emphasis is size, brightness or tracking.

**The Tracking Is Depth Rule.** Letter-spacing steps 0 / 0.02 / 0.04 / 0.07em with depth 0 to 3. Metadata and asides reset to 0.

## Layout

Everything sits on an 11px unit: line height 22px (2u), control height 33px (3u), section gaps 1.5u to 5u, page gutter 44px (16px under 720px). The page is a single left-aligned column up to 1320px, with content sections capped at 1000px. Pulso splits into the queue (fluid) and a 260 to 340px side column (tally plus signal feed) with a 66px gap; the side column is sticky and folds below the queue under 960px. Forms use auto-fit grids with a 280px minimum (dispositions 240px).

Grouping is by baseline and space only. Sub-content indents 3ch, the width of the glyph-head column, so details, facts and device profiles hang under their line's text.

Responsive behavior, from the build:
- Under 900px the top bar stops being sticky and the nav wraps into its own full-width row below the brand and session, so the bar reads as two rows; nav targets drop to 36px.
- Under 720px queue lines reorder into a two-column grid (3ch mark plus text): the explanation (detail) precedes the action, the dotted leader is dropped and asides wrap under the title.
- Under 720px the dust drops its near field (two fields instead of three) to save cost on phones; it loses a depth step, not brightness.
- Under 520px the tenant name hides and the tenant picker narrows to 18ch.

## Elevation & Depth

There are no shadows. Depth is z-order in a literal sense: integer depth on a line sets its brightness, tracking and (for the front line) size, and the dust behind runs at halved rates per field (6, 3, 1.5 px/s from far to near).

A pulled-forward plane is separated by depth, not by a box: it overlaps the list it came from, its siblings recede to 0.38 opacity at 0.992 scale and stop taking pointer input, and the dust eases to a full stop while it is open. Its solid void fill exists only so text stays legible over the overlapped list. Escape or "volver" pushes it back.

### Named Rules
**The Pull Forward Rule.** Detail opens as a plane pulled forward over the queue (260ms, from 12px left at 0.98 scale), never as a modal, drawer or new card. Siblings recede, dust freezes.

**The Still Front Rule.** Whatever is being read does not move: the front plane freezes all drift; reduced motion stops the dust and caret entirely.

## Shapes

Square everything: zero radius on buttons, inputs, scale steps and reversed cells. Frames are 1px hairlines in dust, used only on interactive controls (buttons, inputs, scale steps), never on containers. The recurring silhouettes are typographic: the ">" head, the "·" back mark, "[ ]" / "[x]", the reversed glyph cell, and a dotted leader (1px dots every 9px) that runs from a line's title toward its aside as if the line kept going past the screen.

## Components

### Buttons
Thin square frames with a glyph head; the command reads like a prompt.
- **Shape:** square, 1px dust frame, 33px tall, padding 0 1.4ch, tracking 0.02em.
- **Head:** one head per button, either the ">" glyph (frost) or a pixelarticons icon, never both; an icon replaces the ">".
- **Primary:** amber frame and amber text and head. One per view.
- **Hover / Focus:** frame steps to frost and the ">" head turns amber; primary gains an 8% amber wash. Press scales to 0.97. Focus is a 1px amber outline offset 3px.
- **Quiet:** no frame until hover; used for secondary actions inside lines ("reintentar", "volver a medir").
- **Busy:** a 3ch amber dot crawl after the label. **Disabled:** dust text and head, ash frame.

### Chips
None. Choices among a few options are a glyph row: unselected options in frost, the chosen one ivory with a "> " head; options set 2.4ch apart.

### Cards / Containers
None. Sections are a 22px title over content with space, no frame. The only filled surface is the pulled-forward plane (void fill, no frame, see Elevation & Depth).

### Inputs / Fields
- **Style:** void ground, 1px dust hairline, square, 33px min height, ivory text, frost placeholder. Selects carry a small frost chevron drawn in CSS.
- **Label:** frost label above, 4px gap; hint below in frost.
- **Focus:** frame steps to frost; caret is amber.
- **Error:** frame and message turn ivory (failure is brightness, not red).
- **Toggles:** "[ ]" in frost, "[x]" and label in ivory when checked.
- **Scale (1 to 5):** a row of 33px square hairline cells; the chosen step fills ivory with void numeral.

### Navigation
Standard horizontal nav in the top bar, 44px targets, 2.4ch apart. Links sit at depth 0 brightness; hover lifts to depth 2; the active link is ivory, tracked 0.04em, with an amber "> " head (the location caret). Tabs inside a page use the same treatment. The bar is sticky with a void gradient that fades into the dust; under 900px it is static and wraps.

### Queue Line (signature)
The unit of the whole console. A 3ch mark column ("!" reversed cell if failed, ">" at depth 2 to 3, "·" at depth 0 to 1; amber only at depth 3), the title (22px at depth 3, ellipsized), a dotted leader, a frost aside and the action. Detail text hangs below in frost at 3ch indent. Hovering a pickable line lifts it to depth 3 brightness and turns its mark amber; selecting it pulls its plane forward.

### Dust Field (signature)
A fixed canvas behind the stage: three fields of square frost motes (620 far 1px, 300 mid 1px, 90 near 2px) gathered into two long ribbons that undulate across the viewport, with a minority of strays. Ribbons stay narrow (band spread 4% of viewport height). Fields drift left at 6 / 3 / 1.5 px/s, pause when the tab is hidden and ease to zero while a plane is pulled forward.

### Feedback
Loading is rows of dot skeletons that shimmer sideways, with the amber caret after the waiting line. Failures and notices are a reversed "!" cell followed by ivory text and an optional quiet retry, all on the void.

## Do's and Don'ts

### Do:
- **Do** rank by depth only: brightness depth-0 to depth-3, tracking 0 to 0.07em, 22px for the front line.
- **Do** keep amber to the caret, the front line's mark and one primary action per view at rest.
- **Do** render failure, down tools and missing secrets as a reversed glyph cell (ivory ground, void glyph).
- **Do** give every button exactly one head: ">" or a pixelarticons icon.
- **Do** open detail by pulling a plane forward: siblings to 0.38 opacity, dust frozen, Escape returns.
- **Do** keep all spacing on the 11px unit and indent sub-content 3ch under its line's text.
- **Do** put the explanation before the action under 720px, and wrap the nav into its own row.

### Don't:
- **Don't** box content: no cards, panels, side stripes or dividers; a plane is separated by depth, and its void fill is for legibility only.
- **Don't** use amber for selected choices, checked toggles or the chosen scale step; those are ivory.
- **Don't** introduce red, green or any hue beyond amber; status is brightness and the reversed cell.
- **Don't** pair the ">" head and an icon on the same button.
- **Don't** add a second typeface, bold weights or rounded corners.
- **Don't** let anything move while it is being read.
