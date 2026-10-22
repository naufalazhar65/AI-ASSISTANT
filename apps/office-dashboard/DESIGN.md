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

Navigation uses the same hand-drawn approach: one inline SVG sprite of fifteen
24 × 24 stroke symbols — ten for the rail (`#i-office`, `#i-agents`,
`#i-board`, `#i-calendar`, `#i-usage`, `#i-activity`, `#i-logs`, `#i-memory`,
`#i-files`, `#i-settings`) and five for the header (`#i-menu`, `#i-theme`,
`#i-refresh`, `#i-pause`, `#i-play`) — one stroke weight, `currentColor` fill
so the selected state repaints the glyph instead of swapping a picture.
Unicode dingbats are not used — a bare `◔` reads as a mystery, an icon reads
as a destination. The header follows the same rule: the burger, the theme
toggle, the refresh and the dispatch switch are icon-only buttons with a
`title` + `aria-label`, never a glyph that renders differently per platform.

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
- An agent has no accent colour of its own. Identity is the monogram, the name
  and the role, so the orange accent never leaks into decoration — and no
  per-agent hex value is invented in the markup.

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
- The header shares its row with the canvas, HUD and chat. The view title is
  the one thing in that bar that never shrinks: the title keeps its full
  width and the bar wraps to a second row instead of crushing the text into
  an ellipsis. Below ~1340 px the breadcrumb prefix and the sync timestamp
  go first, and below ~560 px the bus pill and the refresh button follow —
  the title is what stays.
- The dispatch switch is a tinted icon toggle, not a filled button: pausing
  the dispatch is a state, not a warning. It carries that state in colour
  (warn = paused, ok = running) and in its accessible name.
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
- The chat is a sibling panel; under 1200 px it becomes a right drawer, under
  420 px it takes the full width. The breakpoint is 1200 px and not 900 px
  because the rail (248 px) and a docked chat (340 px) together leave the
  header and the view title nothing to work with.
- The chat is **open on wide screens and closed below 1200 px**; the Chat
  button toggles it. Toggling must never recreate the Three.js renderer or
  reset the camera.

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
- The composer is one row: the input, the mic button and the send button share
  height and radius. The send button is an ICON (never the word "Kirim"), and
  the mic sits directly next to it — voice is the same conversation, spoken,
  so it lives in the chat panel instead of a panel of its own.
- The live strip (voice session) is separate from the chat history and hidden
  while nothing happened: idle is silent.
- Long values (ids, URLs, tool output) truncate with an ellipsis or scroll
  inside their own box — they never widen the layout.
- A list view gets one toolbar: a label, a count and the control that changes
  the list (period, level, "lihat semua"). It is the same row on every view,
  so the reader learns once where to look.
- Grids size themselves: cards use `auto-fit` with a narrow floor, so three
  agents fill one row instead of leaving one card alone in a half-empty
  second row, and stat cards stretch to the same height with their subtitle
  right under the value — a pinned subtitle leaves a hole in the middle of
  the card.
- The task board is a 2 × 2 grid of four panels of the same size. Each lane
  scrolls its own list, so a lane with three items and a lane with forty read
  as two panels, not as one tall column and one stub.
- An agent card opens with its identity (monogram, name, status), keeps its
  rows tight, lists the duties as bullets, and pins its buttons to the bottom
  — three cards side by side end on the same line.
- One account, several agents: the account key is printed once and the agent
  names stand beside it. Repeating the key per agent is noise.
- A card holds an object, not a paragraph. An empty preview, an empty file
  list or a missing schedule is a plain note inside the panel that owns it —
  never a second card nested inside the first.

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
- Machine values that do have to be shown are translated before they reach the
  screen: an action key becomes a sentence ("satu giliran assistant"), a turn
  id becomes a group with a count, a log source becomes "audit 20 Okt 2026",
  an absolute path becomes `~/…`, a user key with an agent suffix becomes
  "naufalazhar65 · Mia". The raw value stays in the `title` attribute when it
  is worth keeping.
- The task board groups turns that share a title, so a night of the same
  request reads as one row with a count instead of hundreds of identical
  cards. It shows a handful of groups per lane and offers "Lihat semua" for
  the rest.
- Log lines carry their level as a word plus a colour, and the level is a
  filter. A wall of raw JSON is not a log view.
- Counters are dot + word, and success never shares a chip with failure:
  "Berjalan 448" and "gagal 18" are separate chips with their own colour.
- A machine title becomes a sentence: "Turn mia via 9router" reads as "giliran
  Mia via 9router", and a raw JSON tail in a turn excerpt is cut instead of
  quoted.
- A warning without a reason is not honest: the watchdog row names what it
  could not verify and when it last looked, instead of printing "perhatian".
- The dashboard never describes itself. A card that explains where the data
  comes from is documentation, not a view — the rules live in this file.
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

Two clocks, one system: `--dur: .15s` for colour and border feedback, and
`--motion: .19s` with `--ease` for anything that moves on screen.

Anything that opens **arrives**: a view fades and lifts by one step, the status
panel comes up from the bottom edge, the chat slides in from the right edge
whether it is docked or a drawer, a modal dims the stage and lifts its card,
the scene menu opens from the button it belongs to, and the mobile rail slides
instead of snapping. Nothing blinks into existence.

Anything that closes **leaves**: the chat slides out to the right on its way
out, and it is gone from the pointer and the screen reader at once — a closing
panel must never keep catching clicks while an animation plays. The panel is
removed when the motion ends.

The rules move **opacity and transform only**. Those are compositor properties:
the browser never has to lay the page out again mid-animation, so the 3D canvas
does not resize or rescale while a panel is opening. A view that holds a WebGL
canvas only fades, because a transform would rescale the canvas.

The chat moves **the way the rail moves**: a sheet that slides the whole way
in from the right edge, and a column that gives the canvas its room back as
the sheet leaves. The panel itself is only the anchor — it holds no visible
surface of its own, it just keeps the space reserved while the chat is open.
That split is deliberate: `visibility: hidden` cancels the transitions of
everything inside it, so the surface that has to travel cannot live under it.
The anchor collapses to nothing the moment the chat starts closing, which is
why a closing chat is invisible to the pointer before its slide has even
begun.

Most entrances are tied to the state change itself — `hidden` becoming
visible, `:not(.hide)` matching, `details[open]` — so they need no JavaScript
at all. The chat is the exception: it has to slide out again, and the panel
may only be removed after that motion, so a short `transitionend` listener
(with a timeout as a safety net) does the last step. There is no timer that
can drift out of sync with what the user sees.

`prefers-reduced-motion` disables every animation and transition.
`forced-colors` keeps borders on `CanvasText`.

## Files

| file | role |
|---|---|
| `index.html` | tokens + every dashboard style + the 3D scene + all views |
| `chat.css` | chat sidebar styles (loads after the inline sheet) |
| `chat.js` | chat panel (built once, updated in place) |
| `chat-core.mjs` | pure chat helpers (unit-tested) |
| `design-tokens.json` | machine-readable mirror of the CSS tokens |
