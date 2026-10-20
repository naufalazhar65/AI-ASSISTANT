# AI Office — design system

Warm, playful-minimal dashboard for a live multi-agent office. The reference
character is *approachable SaaS*: warm paper surfaces, one confident orange
accent, rounded-but-not-bubbly controls, generous calm.

**All values live as CSS custom properties in `index.html` (`<style>` →
`:root` / `html[data-theme="dark"]`).** `design-tokens.json` mirrors them for
tooling. Change the token, not the rule.

## Identity

Original to AI Office. No third-party mascot, logo, illustration or brand
asset was copied. The only new artwork is a 26 px flat line-mark (a monitor on
a stand) in the sidebar header, drawn inline as SVG.

Navigation uses the same hand-drawn approach: one inline SVG sprite of ten
24 × 24 stroke symbols (`#i-office`, `#i-agents`, `#i-board`, `#i-calendar`,
`#i-usage`, `#i-activity`, `#i-logs`, `#i-memory`, `#i-files`,
`#i-settings`), one stroke weight, `currentColor` fill so the selected state
repaints the glyph instead of swapping a picture. Unicode dingbats are not
used — a bare `◔` reads as a mystery, an icon reads as a destination.

## Colour

| role | light | dark | used for |
|---|---|---|---|
| background | `#faf7f2` | `#1c1815` | page behind panels |
| surface | `#ffffff` | `#231f1b` | cards, chat, HUD, header |
| surface alt | `#f7f1e8` | `#2b2621` | sidebar, lanes, code blocks |
| border | `#e8e0d6` | `#3b342d` | hairlines, card edges |
| text | `#2b2724` | `#f3eee7` | primary |
| muted | `#635c53` | `#b8ada1` | secondary, labels |
| faint | `#7f776d` | `#9a8f83` | tertiary, timestamps |
| accent | `#e99a56` | `#e99a56` | primary action fill, selected state |
| accent ink | `#a85c1a` | `#f0ae6e` | accent-coloured **text** (accent is too light to read on white) |
| ok / warn / bad | `#3d7a5a` `#8f6112` `#a8442f` | `#7fc0a0` `#e0b071` `#e3907c` | real status only |

Rules that keep it warm instead of loud:

- Orange marks **primary actions and selected states** — never decoration.
- Status colour never carries meaning alone: a dot is always paired with a word.
- The 3D scene keeps its own natural colours. The app palette is not pushed into it.

## Typography

`Nunito → Avenir Next → Segoe UI Variable → system-ui` (all local; no webfont
download). Mono for ids, code and raw log lines: `ui-monospace → SF Mono →
Menlo`.

Scale: `11 / 12 / 13.5 / 15 / 17 / 21 / 30 px`. Nothing operational is below
11 px. Section labels are uppercase 11 px in `--text-muted` (never faint grey).
Headings are 650–750 weight with `-0.01em` tracking; body text is 1.5–1.62
line-height.

## Shape & depth

Radii: `8` small controls · `10` inputs/buttons · `14` cards/panels · `18`
modals and the mobile sheet. `999` only for status chips (`.pill`, `.badge`)
and the scroll-to-latest affordance — never for cards, inputs or buttons.

Shadows are warm and low-contrast (`rgba(92,70,44,…)`), never black.

## Layout

```
┌────────┬──────────────────────────┬────────┬────────┐
│ rail   │ virtual office (canvas)  │  HUD   │  chat  │
│ 60/248 │       flexible           │  322   │  340   │
└────────┴──────────────────────────┴────────┴────────┘
```

- The rail collapses to a 60 px icon rail; every icon-only button keeps a
  `title` + `aria-label` tooltip. Collapsed, each destination is a 38 px
  square plate and the current one is a solid accent square (orange fill,
  dark ink) — a filled lamp, never an offset stripe that reads as a broken
  shape at 60 px. Group headings collapse into hairline rules so the rail
  still reads as four groups instead of ten loose glyphs.
- The header shares its row with the canvas, HUD and chat: below ~1100 px it
  drops the breadcrumb prefix and the sync timestamp and wraps to a second
  row, so the view title is never squeezed into an ellipsis.
- Canvas overlays wrap instead of scrolling: room chips flow onto a second
  row and the status pills stack, so nothing is cut in half by a scrollbar
  the user cannot see.
- The bottom overlay is **one HUD bar**, not a row of loose pills: a single
  warm surface holds the counters, the roster and the Panel button, and the
  chips inside it are flat. The bar owns its pointer events — a control inside
  an overlay that inherits `pointer-events: none` is dead to the mouse.
- A nameplate is a caption, not a card: tighter padding, smaller radius, one
  shadow step. It sits over a bright 3D scene, so every pixel of weight it
  carries is weight on the picture.
- The HUD (crew + agent detail) is a sibling of the canvas so the office keeps
  the bright surface; it becomes a bottom sheet under 820 px.
- The chat is a sibling panel; under 900 px it becomes a right drawer, under
  420 px it takes the full width.
- The chat is **open on wide screens and closed on phones**; the Chat button
  toggles it. Toggling must never recreate the Three.js renderer or reset the
  camera.

## Component rules

- **One box per group, not per row.** Task rows, log lines and table rows use
  spacing and surface tint; only genuinely separate objects get a card.
- Buttons: neutral outline by default, `.primary` = solid orange (the only
  filled orange button in the app), `.warn` / `.ok` = tinted state buttons.
- Inputs: white surface, `--border-strong` edge, accent border + soft ring on
  focus.
- Segmented controls (period picker, agent selector): neutral track, accent
  fill on the active segment.
- Empty states: a soft dashed well with one honest sentence. No decorative art.
- The chat's empty state never repeats the identity the header already shows
  (name, role, avatar). It starts the conversation instead: one honest
  sentence, then an even stack of starting points, anchored under the header
  instead of floating in the middle of the panel.
- The composer is one row: the input and the send button share height and
  radius.
- Long values (ids, URLs, tool output) truncate with an ellipsis or scroll
  inside their own box — they never widen the layout.

## State honesty

Every visible indicator is wired to real state:

- The API dot and the bus pill reflect the actual connection.
- The agent nameplate dot reflects the derived scene state, the crew card
  reflects the backend status; they are different facts and are labelled
  differently.
- A nameplate shows the human activity label ("makan bakso", "istirahat kopi")
  when the agent is idle, and the real tool summary when it is working. It
  never implies a task that the backend did not report.
- Machine-shaped values (basis, counters, provenance, scene signals) live in
  the collapsed **Diagnostics** block of the agent panel, never in the primary
  summary.
- Counters are dot + word, and success never shares a chip with failure:
  "Berjalan 448" and "gagal 18" are separate chips with their own colour.
- Idle is silent. The chat header shows the agent's availability and drops the
  task line when no turn is running, instead of printing "no turn is active".
  A status that arrived from the server must reach the panel even when the
  panel has no other news to render.

## Tool cards & execution truth

A card is anchored to the turn that proposed it (the card id IS the provider's
`tool_call_id`), and its state is only ever what the backend reported:

| state | meaning |
|---|---|
| `queued` | proposed, not run yet (turn still open) |
| `running` | `tool_started` fired — the call is in flight |
| `awaiting_approval` | FR-014 pause, waiting for the owner |
| `succeeded` / `failed` / `timed_out` | a real tool result exists |
| `cancelled` | explicitly declined — it did NOT run |
| `unknown` | NO outcome on record — never rendered as success |

Three separate fields keep a diagnostic from masquerading as a status:
`summary` (user-facing one-liner), `result` (short first line of the real
output) and `detail` (full sanitized output, collapsed behind "Detail teknis").

Two more rules the UI enforces:

- A declined call gets a deterministic correction line right after the agent's
  reply, because the agent's own words can claim the action happened.
- A backend nudge (`[email-gate] …`) is rendered as a quiet note, never as a
  message the owner supposedly sent.

## Motion

`--dur: .15s`, colour/border/opacity only. `prefers-reduced-motion` disables
every animation and transition. `forced-colors` keeps borders on `CanvasText`.

## Files

| file | role |
|---|---|
| `index.html` | tokens + every dashboard style + the 3D scene + all views |
| `chat.css` | chat sidebar styles (loads after the inline sheet) |
| `chat.js` | chat panel (built once, updated in place) |
| `chat-core.mjs` | pure chat helpers (unit-tested) |
| `design-tokens.json` | machine-readable mirror of the CSS tokens |
