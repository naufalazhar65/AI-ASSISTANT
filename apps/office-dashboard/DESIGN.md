# AI Office — Design System

> **Design direction:** Saweria-inspired, warm, playful-bold SaaS for a live multi-agent virtual office.
>
> This document is the source of truth for visual design and interaction rules. It describes an original AI Office identity inspired by broad visual principles such as warm surfaces, confident outlines, expressive accent colours, friendly typography, and selective offset shadows. It is **not** a reproduction of Saweria's UI, brand assets, mascots, or exact component designs.

## 1. Product identity

AI Office is a desktop-first virtual workspace for Mia, Agnes, and Michelle. The interface surrounds a live 3D office scene with navigation, agent status, operational views, and a conversation panel.

The product should feel:

- **Warm:** paper-like backgrounds and human-readable typography.
- **Playful-bold:** decisive outlines, a confident yellow accent, occasional colourful surfaces, and controlled offset shadows.
- **Practical:** operational information remains easy to scan and never becomes decoration.
- **Original:** the 3D office, agent identities, iconography, and illustrations belong to AI Office.
- **Trustworthy:** statuses and results always reflect real application state.

The visual direction should not become a generic dashboard, a neon cyberpunk UI, or a clone of Saweria. Visual personality comes from a consistent system, not from decorating every component.

## 2. Non-negotiable principles

1. **The 3D scene is not part of the app colour system.** Never recolour or restyle the environment to match the UI palette.
2. **No invented state.** Visible status, counters, tool results, and activity labels must come from actual runtime data.
3. **One box per meaningful group.** Do not wrap every row, metric, or message in a card.
4. **Accent colour has a job.** Use yellow/orange for primary actions and selected states, not as random decoration.
5. **Bold does not mean heavy everywhere.** Reserve strong outlines and offset shadows for selected, interactive, or genuinely important surfaces.
6. **No copied brand assets.** Do not use Saweria's logo, mascots, illustrations, or proprietary artwork.
7. **Preserve behaviour.** Visual changes must not break chat, agent routing, tools, status updates, or the 3D renderer.
8. **Design tokens are authoritative.** Change shared tokens before adding isolated values in component styles.

## 3. Source files and ownership

Verify these paths in the current repository before editing; do not assume the structure has not changed.

| File | Responsibility |
|---|---|
| `index.html` | Design tokens, global dashboard styles, 3D scene, and views (if still structured this way) |
| `chat.css` | Chat panel styles |
| `chat.js` | Chat panel rendering and interactions |
| `chat-core.mjs` | Pure chat helpers and related unit tests |
| `design-tokens.json` | Machine-readable mirror of CSS design tokens |
| `DESIGN.md` | Human-readable source of truth for visual rules and component behaviour |

If the codebase has moved these responsibilities, update the actual current files rather than creating duplicate implementations. Keep `design-tokens.json` synchronised with the CSS tokens whenever tokens change.

## 4. Colour system

### 4.1 Light theme — default direction

Use a warm-paper background, white surfaces, dark ink, and a confident sunny-yellow accent. Teal and coral are supporting surface colours, not competing primary accents.

| Token | Value | Usage |
|---|---|---|
| `--bg` | `#FFF9F0` | Main application background |
| `--surface` | `#FFFFFF` | Primary panels, chat, cards, and header surfaces |
| `--surface-alt` | `#FFF1DC` | Sidebar groups, secondary lanes, selected-area backgrounds |
| `--surface-soft` | `#F8EEDD` | Quiet wells and secondary regions |
| `--text` | `#292520` | Primary text and icon ink |
| `--text-muted` | `#655B50` | Secondary text and labels |
| `--text-faint` | `#73695E` | Timestamps and low-priority metadata; never essential information |
| `--border` | `#E4D8C8` | Subtle separators and standard input edges |
| `--border-strong` | `#342D26` | Strong card outlines and emphasis where needed |
| `--accent` | `#FFBE2E` | Primary action fill and selected-state accent |
| `--accent-ink` | `#302309` | Text/icons on yellow accent surfaces |
| `--accent-secondary` | `#F39A45` | Secondary accent, limited use |
| `--accent-secondary-ink` | `#38200B` | Text/icons on orange accent surfaces |
| `--teal-soft` | `#BFE8E3` | Occasional secondary surface or small illustration detail |
| `--coral-soft` | `#F5B8B1` | Occasional secondary surface or small illustration detail |
| `--lilac-soft` | `#D9CCF2` | Optional illustration/supporting surface; use sparingly |
| `--ok-bg` | `#DDF2E5` | Success/connected status background |
| `--ok-ink` | `#286044` | Success/connected status text and icon |
| `--warn-bg` | `#FFF0CE` | Warning status background |
| `--warn-ink` | `#855300` | Warning status text and icon |
| `--bad-bg` | `#FBE3DE` | Error status background |
| `--bad-ink` | `#8E3326` | Error status text and icon |

> The CSS keeps the older short names (`--faint`, `--ok`, `--ok-2`, `--warn`, `--warn-2`, `--bad`, `--bad-2`, `--shadow`, `--panel`, `--muted`) as aliases that resolve to these canonical tokens.
> `--border-strong`, `--teal-soft`, `--coral-soft` and `--lilac-soft` are defined but **reserved**: use them only where a strong outline or a secondary surface genuinely helps. They carry no automatic styling.

These values are proposed AI Office tokens, not official Saweria brand values. Check contrast in the rendered application and tune tokens when required; do not silently replace the palette with ad-hoc colours.

### 4.2 Dark theme

Keep dark theme supported. It must be intentionally designed, not produced by applying an indiscriminate colour inversion.

| Token | Value | Usage |
|---|---|---|
| `--bg` | `#1C1815` | Main application background |
| `--surface` | `#27221E` | Primary panels and cards |
| `--surface-alt` | `#322B25` | Secondary panels and navigation groups |
| `--surface-soft` | `#3A312A` | Quiet wells and secondary regions |
| `--text` | `#F4EEE6` | Primary text and icon ink |
| `--text-muted` | `#C6B9AA` | Secondary text and labels |
| `--text-faint` | `#A99A89` | Timestamps and low-priority metadata |
| `--border` | `#4B4036` | Subtle separators and standard edges |
| `--border-strong` | `#E7D9C8` | Strong outlines where they remain useful on dark surfaces |
| `--accent` | `#FFBE2E` | Primary action fill and selected-state accent |
| `--accent-ink` | `#302309` | Text/icons on yellow accent surfaces |
| `--accent-secondary` | `#F39A45` | Secondary accent, limited use |
| `--accent-secondary-ink` | `#38200B` | Text/icons on orange accent surfaces |
| `--teal-soft` | `#284B47` | Muted teal supporting surface |
| `--coral-soft` | `#54342F` | Muted coral supporting surface |
| `--lilac-soft` | `#443952` | Muted lilac supporting surface |
| `--ok-bg` | `#244335` | Success/connected status background |
| `--ok-ink` | `#9BD8B3` | Success/connected status text and icon |
| `--warn-bg` | `#4C3B20` | Warning status background |
| `--warn-ink` | `#F1CB83` | Warning status text and icon |
| `--bad-bg` | `#502C28` | Error status background |
| `--bad-ink` | `#F0A69A` | Error status text and icon |

### 4.3 Colour rules

- Light theme is the default for new users unless existing product requirements or saved preferences say otherwise.
- Respect a user's saved theme preference. Do not reset their preference on every page load.
- Yellow is the primary accent. Use orange as a secondary accent, not as a competing primary colour.
- Within a local action group, ordinarily use only one filled primary button.
- Do not use colour alone to communicate success, warning, error, connection, or availability. Pair the colour with a label or accessible name.
- Status colours must describe real status, never decoration.
- Teal, coral, and lilac are secondary surfaces. Do not use all of them in every view.
- The 3D scene keeps its original materials and natural colours. UI theme changes must not tint the Three.js scene.
- Check text contrast, including placeholder text, icons, disabled states, and focus states.

## 5. Typography

Use a locally available sans-serif stack; do not introduce a mandatory external font request solely for the redesign.

Recommended stack:

```css
font-family: Nunito, "Avenir Next", "Segoe UI Variable", system-ui, sans-serif;
```

Use a monospace stack for IDs, code, and raw log lines:

```css
font-family: ui-monospace, "SF Mono", Menlo, monospace;
```

### Type scale

| Token / intended role | Size |
|---|---:|
| Tiny metadata, minimum operational text | `11px` |
| Secondary metadata and timestamps | `12px` |
| Compact labels | `13.5px` |
| Default body and controls | `15px` |
| Emphasised body / card title | `17px` |
| Section heading | `21px` |
| Page title / high-level value | `30px` |

Rules:

- Nothing operational should be smaller than 11 px.
- Use 650–750 font weight for major headings, with slight negative letter spacing only where it improves the result.
- Body copy generally uses `1.5–1.62` line-height.
- Do not make every label bold to create a playful look.
- Metadata must remain readable; do not use very faint text for important status or guidance.
- Large report content, code, and long logs must remain readable without widening the layout.
- Chat body text should remain compact enough to show a useful amount of history while retaining comfortable line length and line-height.

## 6. Shape, borders, and depth

### Radius scale

- `6–8px`: small controls and compact icon buttons.
- `8–10px`: inputs and standard buttons.
- `12–14px`: cards, chat panel surfaces, and dashboard groups.
- `16–18px`: modals and mobile sheets.
- `999px`: status chips and badges only when a pill is the clearest representation.

Do not make every element pill-shaped. Segmented controls may have a rounded track, but their internal buttons should remain visually proportionate.

### Border rules

- Use subtle borders for separation and strong dark-ink outlines selectively for important cards or interactive elements.
- A bold outline is a visual accent, not a default for every row.
- Inputs need a clear border and visible focus state.
- Do not nest a bordered card inside another card unless the inner item is a separate object with its own interaction.
- Avoid duplicating a border, shadow, and tinted background when one or two signals are sufficient.

### Shadow rules

Use two intentional shadow types:

```css
/* Warm, quiet elevation for floating surfaces. */
--shadow-soft: 0 8px 22px rgba(55, 40, 23, 0.12);

/* Small offset shadow for selected expressive components only. */
--shadow-offset: 3px 4px 0 rgba(41, 37, 32, 0.16);
```

- Use soft shadow for popovers, drawers, and surfaces that float above other content.
- Use offset shadow selectively on primary/selected components where it supports the playful-bold identity.
- Do not apply offset shadow to every card, input, or message bubble.
- Avoid large black shadows and decorative glow.

## 7. Iconography and original artwork

- Use the existing inline SVG icon sprite if it is still present and suitable.
- Icons should share consistent viewBox, stroke width, line cap, and line join.
- Use `currentColor` so hover, selected, and disabled states work without swapping artwork unnecessarily.
- Icon-only buttons must have a `title`, an accessible name, and a usable hit area.
- Do not use Unicode dingbats as substitutes for interface icons.
- Keep icon style consistent across the rail, header, chat composer, and panels.
- Any new illustration should be original to AI Office: simple, playful, and secondary to the data.
- Do not import or trace Saweria's mascot, logo, illustrations, or proprietary artwork.
- Do not add decorative illustrations to empty states unless they materially improve comprehension.

## 8. Layout

The application is a virtual office, not a generic analytics dashboard. The live 3D canvas remains the central experience, while surrounding controls and chat use the design system above.

Reference desktop structure:

```text
┌────────┬──────────────────────────┬────────┬────────┐
│ rail   │ virtual office (canvas)  │  HUD   │  chat  │
│ 60/248 │       flexible           │  322   │  340   │
└────────┴──────────────────────────┴────────┴────────┘
```

These dimensions are starting points from the existing layout, not instructions to force fixed widths if the current code already handles the viewport better.

### Rail and navigation

- The rail collapses to a 60 px icon rail; expanded width may use the existing 248 px layout.
- Every icon-only destination retains a tooltip and accessible name.
- In collapsed mode, each destination uses a consistent square hit area; the active destination uses a clear filled accent surface rather than a detached stripe.
- Group headings can collapse to subtle rules so the rail still reads as organised groups.
- Keep navigation icons consistent; do not add card backgrounds to every menu item.

### Header

- The page/scene title is the most stable item in the header and must not be crushed into an ellipsis unnecessarily.
- At constrained widths, remove low-priority breadcrumb details and sync timestamp before the title.
- Secondary icon-only controls must retain tooltip and accessible name.
- Use a tinted toggle for dispatch pause/running state; do not make pause look like a destructive action unless it truly is one.
- Keep the header visually lighter than the canvas and avoid duplicating a border around every control.

### Canvas overlays and HUD

- Room/area chips wrap instead of becoming a hidden horizontal scrollbar.
- The bottom overlay is one grouped HUD surface, not a series of unrelated pills.
- Every HUD chip states what it counts and over which period. A chip without a real value is not rendered at all (no empty "Cron —").
- The HUD and the task board compute their counters with the same helper, so the two views can never disagree about what is running.
- Flat status chips sit within the HUD; reserve individual cards for genuinely separate information.
- The HUD is a sibling of the canvas, not a filter applied to the 3D scene.
- On narrow screens, it may become a bottom sheet if that behaviour already exists or can be added without disturbing the renderer.
- Controls inside an overlay must remain interactive; verify `pointer-events` behaviour rather than allowing a decorative wrapper to disable its children.

### Chat layout and responsive behaviour

- The chat is a sibling panel to the canvas.
- Target behaviour from the existing design: chat is docked/open on wide screens, becomes a right-side drawer below about 1200 px, and can take the full width on very narrow screens (about 420 px and below).
- The docked width is fluid: `clamp(360px, 30vw, 460px)`. The panel grows with the viewport but never eats the Virtual Office, and the token lives in `design-tokens.json` (`layout.chatWidth`).
- Verify the actual breakpoints against the current implementation before changing them.
- The Chat control opens/closes the panel without recreating the Three.js renderer or resetting the camera.
- When a panel closes, it must immediately stop receiving pointer and keyboard interaction, even if its exit animation is still running.
- Do not change the camera framing, zoom, scene geometry, object placement, lighting, materials, or character movement as part of UI restyling.

## 9. Component rules

### General surfaces

- One box per meaningful group, not per row.
- Use spacing and surface tint for task rows, log rows, and table rows.
- A card holds an object or a coherent group, not a paragraph wrapped in unnecessary containers.
- Empty previews, empty file lists, and missing schedules use a plain note inside the owning panel, not a second nested card.
- Data grids should size naturally. Related cards should align when they belong together, but do not create awkward empty space just to force uniform heights.

### Buttons

- Primary: solid yellow with dark ink, for the principal action in a group.
- Secondary: neutral surface with a clear border.
- Tertiary: minimal visual treatment for low-priority actions.
- Warning, success, and destructive states must use semantic tokens and labels.
- A button's visual treatment must match what it actually does.
- Every visible control must have a working action or be clearly disabled.
- Do not use a filled accent button merely as decoration.

### Inputs

- Use a surface that separates the input from its parent panel.
- Use `--border-strong` only where stronger definition improves usability; standard inputs may use `--border`.
- Focus state must be clearly visible using an accent border and restrained focus ring.
- Placeholder text must not be the only label for important or persistent settings.
- Keep text, mic, and send controls aligned in the chat composer.

### Segmented controls

- Use a neutral track and clear filled or tinted active segment.
- The selected segment must be obvious without relying only on text colour.
- Keep options evenly aligned and maintain appropriate keyboard behaviour.
- The agent selector should not resemble three unrelated cards.

### Selected state

- Chrome selections (rail, area chips, segmented controls, file tree, HUD tabs and crew cards) share one visual language: accent surface (`--accent-2`) + accent hairline (`--accent-edge`) + stronger weight. Never a colour swap alone.
- Hover stays neutral (`--panel-3`) so a hover can never be read as a selection.
- The selected state looks the same whether the control is expanded or collapsed.
- Two documented exceptions: the chat agent tab keeps a solid accent fill, because it names the subject of the panel beside it; the 3D scene nameplate keeps its expressive accent outline and offset shadow, because it marks a picked object in the scene, not a chrome selection.

### Status chips and badges

- A status colour is always paired with a word or accessible label.
- Use pill shapes for status chips only when a compact badge is useful.
- Do not use badges for headings, ordinary metadata, or decoration.
- Never show an indicator without a defined, real state behind it.

### Empty states

- Use a quiet surface or subtle dashed well if a boundary helps comprehension.
- Write one honest explanatory sentence and show only relevant next actions.
- Do not repeat the agent identity already visible in the header.
- Anchor chat starting points below the header rather than floating them in the centre of the panel.
- Do not invent empty-state artwork or decorative cards just to fill the space.

## 10. Chat panel rules

The chat must share the warm, playful-bold design language without becoming visually loud. Conversation content is the main object.

### Header and agent selector

- Keep avatar, name, role, and availability compact.
- The name is primary; role is supporting text.
- Availability and task state are different concepts and must not be conflated.
- Avoid repeated dividers and excessive vertical padding.
- The selector uses one consistent track with a clear active state.
- The identity block stays compact: avatar 40px, name 17px, role 12px, status 11px. The name leads; the role supports it.
- The active agent wears the yellow accent; the others stay on a warm surface. A status dot appears only for a real non-idle state (working, offline) — never as decoration on every agent.

### Message stream

- Group consecutive messages from the same sender when appropriate.
- Do not repeat the avatar and full identity metadata for every adjacent message if grouping remains clear.
- Names should be visually stronger than timestamps.
- Use timestamps as clock times. Show the date only when the day changes, using a single centred separator per day, similar to common chat applications.
- If the timestamp is unknown, show no time and do not invent a date.
- User bubbles may align right; agent messages may align left, following the existing interaction pattern.
- Keep bubble padding compact. Avoid heavy outline plus heavy shadow plus strong background on every message.
- Long URLs, IDs, tool output, and code must wrap, truncate with accessible detail, or scroll inside their own container; they must not widen the panel.
- Only newly arrived messages animate. Historical messages should load without entrance animation.
- Conversation typography: body 15px with a 1.55 line height, sender name 13.5px, timestamp 11px, day separator 12px. Metadata stays readable, never faint-on-faint.
- A new group starts when the sender changes OR when more than five minutes of silence separate two messages. Inside a group the identity line is drawn once and the messages sit tight.
- The agent speaks on the panel itself — plain text, no card per message. The owner's message is the only bubble: warm cream surface, dark ink, a neutral border and a capped width that never breaks a word in the middle.

### Composer

- Keep the input, microphone, and send button in one aligned row when the viewport supports it.
- The send action uses an icon rather than the word "Kirim" if that is the established project convention; retain an accessible name.
- The mic sits directly beside send because voice is part of the same conversation.
- Show keyboard hints unobtrusively and do not let them compete with the composer.
- Keep the voice session strip separate from chat history and hidden when nothing has happened.
- The input, microphone and send button share one height (46px) and one radius. The input grows with the text; the send action is the yellow icon button; the microphone stays neutral until the voice session is live.
- Do not change send behaviour, Enter/Shift+Enter semantics, voice input, streaming, or cancellation while adjusting visual styles.

### Typing indicator

- The typing row belongs directly below the last message in the conversation stream, not fixed to the bottom of the panel.
- Use the agent's actual avatar; a letter or monogram is only a fallback when the image cannot load.
- Show the indicator as soon as a real assistant turn is in flight, not only after the server eventually responds.
- Remove it when that turn ends or fails.
- It must reflect runtime state, not an animation that runs continuously to make the UI seem alive.

## 11. Agent nameplates and activity state

A nameplate is a caption, not a card. Keep it light so the 3D office remains the focus.

- Show the agent name and a short human-readable status/activity label.
- Avoid permanently displaying role, room name, task IDs, internal function names, or other machine-shaped metadata.
- Show additional role or task detail on hover, selection, or in the agent detail panel when appropriate.
- Nameplates should not overlap unnecessarily or cover key character/scene details.
- Do not change character position, model, animation, or camera to solve a nameplate problem.
- Use the actual activity label when an agent is idle and the real tool/task summary when the backend reports work.
- Never imply a task the backend did not report.
- An agent has no unique accent colour by default. Identity is communicated through photo/avatar, name, role, and actual state—not arbitrary per-agent hex values.

### Distinguish task state from idle animation

Task state and visual idle animation are separate facts.

- If the agent is executing a task, show a concise real task summary.
- If the agent is genuinely idle, show a human-readable idle activity when available.
- An animation such as drinking coffee or sitting down must not overwrite an active task status.
- Do not infer task status from the character's position or animation alone.
- Translate internal values before showing them; never render raw event names, enum values, function names, or IDs as the primary activity label.
- The status line under a name is a human sentence about the work ("melakukan riset", "menulis kode"), never a tool identifier, a locale, a task id, or a raw argument.
- The raw action, the tool name and its arguments stay available in the agent panel Diagnostics.

## 12. State honesty and display data

Every visible indicator is wired to real application state.

- The API connection dot and bus status reflect actual connectivity.
- The scene nameplate status and backend agent status may represent different facts; label them accurately instead of pretending they are the same state.
- Counters display the real value and its meaning. If a counter has no known meaning, investigate before showing it.
- A counter also states its period: running work counts what was updated in the last few minutes, failures count the last day.
- Ledger rows that were never closed are disclosed as a backlog, not presented as live work.
- Success and failure use separate indicators; never put them in one ambiguous chip.
- The warning row names what could not be verified and when it was last checked rather than showing a vague "attention" state.
- Idle is quiet. Do not print "no turn is active" in the main summary when there is no active task.
- A dashboard should present operational information, not explain its own design or data plumbing.

### Diagnostics and machine-shaped values

- Machine-shaped values such as basis, counters, provenance, scene signals, raw payloads, and internal IDs belong in a collapsed **Diagnostics** section of the agent panel, not in the primary summary.
- Translate necessary machine values into human-readable text before display. Examples: an action key becomes a short sentence; a turn ID becomes a group with a count; an absolute path is abbreviated; an internal user key is rendered as a readable account/agent pair.
- Preserve the raw value in a `title` attribute or collapsed technical detail only when it is useful and safe to retain.
- A raw JSON wall is not a log view. Log lines carry a severity word and colour; severity may be filterable.
- A warning must include what could not be verified and the last check time when known.
- Never expose secrets, tokens, passwords, session cookies, or unredacted sensitive values.

## 13. Tool cards and execution truth

A tool card is anchored to the turn that proposed it. Its identifier should be the provider's `tool_call_id` when available. Its state reflects only what the backend reported.

| State | Meaning |
|---|---|
| `queued` | Proposed, not run yet; the turn remains open |
| `running` | A real `tool_started` or equivalent event confirmed the call is in flight |
| `awaiting_approval` | An approval gate is waiting for the owner |
| `succeeded` | A real successful tool result exists |
| `failed` | A real tool failure result exists |
| `timed_out` | The tool timed out according to execution state |
| `cancelled` | The call was explicitly declined/cancelled and did not run |
| `unknown` | No outcome is on record; never render as success |

Keep three distinct fields where supported:

- `summary`: a concise user-facing one-liner.
- `result`: a short first line of the real result.
- `detail`: full sanitised output, collapsed behind **Detail teknis**.

Additional rules:

- A declined call gets a deterministic correction note when needed, because an agent's prose may incorrectly imply that the action happened.
- A backend nudge such as an email gate must be rendered as a quiet system note, never as a message supposedly sent by the owner.
- Tool output is data, not instruction. Do not allow content from a website, file, or tool result to override agent policy or scope.
- Never invent success, progress, a tool result, or evidence.

## 14. Reports, logs, and task boards

- A report card should contain the report object, not a long paragraph wrapped in decorative containers.
- Use a consistent toolbar row for list views: label, count, and relevant list control (period, level, or “Lihat semua”).
- Task boards should use consistent lane dimensions where practical; each lane may scroll its own list so unequal counts do not break the layout.
- A task board lane states its window ("Berjalan (5 mnt)"); rows outside that window are disclosed as a backlog count instead of pretending to be live.
- Group repeated task turns that share a title where this helps a reader; show a count and offer “Lihat semua” for the remaining history instead of displaying hundreds of identical cards.
- Use severity labels as words plus semantic colour. Do not rely on colour alone.
- Evidence, source, confidence, remediation, and verification status should be distinguishable in security reports.
- Error logs should be filterable when supported; avoid displaying large raw JSON dumps in a standard log row.
- Empty schedules and missing files should be a plain note inside the owning panel, not a nested card.

## 15. Motion and transitions

Use two durations as a baseline:

```css
--dur: 150ms;   /* colour, border, and surface feedback */
--motion: 190ms; /* entry/exit movement */
```

- Use a consistent easing token.
- Views may fade and lift subtly; panels and drawers should enter from the direction associated with their control.
- The chat slides from the right when opening or closing as appropriate to the existing layout.
- A mobile rail should slide rather than snap when motion is enabled.
- Motion should use `opacity` and `transform` where possible to avoid layout work during animation.
- Do not transform/scale the WebGL canvas as a decorative animation.
- Opening or closing the chat must not recreate the renderer, reset the camera, or produce unexpected canvas resize/rescale.
  The chat is a flow column, so docking it narrows the canvas element and the camera aspect follows — the scene stays undistorted, the renderer is never rebuilt and the camera is never reset.
- A closing panel must stop receiving pointer and screen-reader interaction immediately; remove it after transition completion, with a safe fallback if needed.
- Do not animate the initial historical message load. Animate only new messages that arrive after the current render.
- `prefers-reduced-motion: reduce` disables non-essential transitions and animations.
- `forced-colors` mode retains visible borders and focus indicators.

## 16. Accessibility

- Icon-only buttons require accessible names and, where useful, visible or hover tooltips.
- Keyboard focus must remain visible in both themes.
- Every status communicated by colour also has a text label or accessible equivalent.
- Inputs have labels or accessible names; placeholders alone are not enough for persistent settings.
- Keep reasonable hit areas for buttons and icon controls.
- Prevent hidden/closing drawers from accepting focus or pointer events.
- Maintain semantic heading order and use appropriate interactive elements.
- Do not remove keyboard operation while restyling segmented controls, navigation, or chat.
- Support reduced motion and forced colours.

## 17. Responsive behaviour

Verify the existing breakpoints before changing them. Reference behaviour from the current design:

- The chat is docked/open on wide screens.
- Below approximately `1200px`, the chat becomes a right drawer and is closed by default if that is the established product behaviour.
- The chat takes the full width at `700px` and below (the tested breakpoint in this implementation, so `420px` and below is included) and only bumps the input font size at `420px`.
- The rail can collapse to its icon-only state.
- HUD elements wrap or become a bottom sheet on narrow screens rather than being clipped by an invisible horizontal scrollbar.
- Header items yield low-priority metadata before sacrificing the page title.

Do not force these exact values if the real repository uses a better tested responsive system. Keep responsive behaviour coherent and test at the actual target widths.

## 18. Theme and rendering performance

- Theme changes update tokens and normal DOM elements without rebuilding the 3D renderer.
- Opening/closing chat, switching agents, or changing views must not reset the camera or recreate the Three.js scene.
- Avoid unnecessary full-panel rebuilds when a small state update can update the existing component.
- Keep chat pure helpers separately testable where the current architecture supports it.
- Do not use CSS selectors that unintentionally recolour the canvas or in-scene materials.
- Test pointer events around overlays carefully; decorative wrappers must not disable interactive controls beneath them or inside them.

## 19. Validation checklist

Before declaring a design change complete:

- [ ] Light theme matches the warm, playful-bold direction.
- [ ] Dark theme remains legible and intentional.
- [ ] `design-tokens.json` matches the implemented CSS custom properties.
- [ ] No accidental hardcoded colour/radius/shadow values conflict with tokens.
- [ ] One filled primary action is used per local action group in normal cases.
- [ ] Cards exist only around meaningful objects or groups.
- [ ] Chat remains readable, compact, and functional.
- [ ] Diagnostics are separated from human-facing summaries.
- [ ] All status indicators reflect real state.
- [ ] Nameplates remain captions rather than oversized cards.
- [ ] Task status is not overwritten by idle animation.
- [ ] Tool states reflect backend execution truth.
- [ ] Long URLs, IDs, and tool output do not widen the layout.
- [ ] Header, navigation, HUD, chat, and drawers work at target breakpoints.
- [ ] Theme and panel changes do not recreate the 3D renderer or reset the camera.
- [ ] Keyboard focus, labels, reduced motion, and forced-colour behaviour remain usable.
- [ ] Build, lint, and relevant tests have been run; any failures are reported honestly.
- [ ] A before/after screenshot was inspected at the same viewport size where browser preview is available.

## 20. Change process

When implementing a new design change:

1. Inspect the existing implementation and identify the owning component.
2. Change the relevant design token first when the issue is shared across components.
3. Make the smallest set of component changes that achieves the intended visual result.
4. Keep data contracts, state management, agent routing, and tool execution unchanged unless the task explicitly requires a behaviour fix.
5. Update `design-tokens.json` whenever a token changes.
6. Validate both themes and all affected interaction states.
7. Inspect a rendered screenshot; source-code edits alone are not proof of visual success.
8. Report the files changed, visual decisions, test results, and any limitations.

Do not rewrite the whole dashboard merely to modernise one component. Conversely, do not leave conflicting styles or token definitions behind after a system-wide redesign.

## 21. Final design target

AI Office should feel like an original, warm, playful-bold SaaS product with a distinctive yellow-led visual identity, clear outlines, restrained offset shadows, expressive but controlled colour, and friendly typography. It must remain an efficient operational workspace, not a decorative landing page.

The 3D office stays the central visual identity. Agent activity remains honest. Chat stays readable. Diagnostics stay in diagnostics. Controls remain accessible and functional. All visual elements must earn their place on the screen.
