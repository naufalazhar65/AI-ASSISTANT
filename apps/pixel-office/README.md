# Pixel Office (Fase 3)

Minimal viewer: 1 room, 3 avatars, 3 PCs. TypeScript + Canvas, no framework.
Talks to the Mia backend **only** via SSE (`/api/bus/stream`) — no other coupling.

## Run

```bash
# from the repo root, after any change here:
npm run build -w @mia/pixel-office
# then open http://localhost:3000/pixel-office/ (served by the Next server)
```

`?user=` selects whose bus to watch (default: owner key).

## Decisions (MVP)

- PC positions fixed on the map; assignment is dynamic from `task_assigned.station`.
- Single viewer, no auth (same trust level as the local web UI).
- Movement is automatic from task events (no explicit move commands).
- Avatars walk back to spawn on done/failed/cancelled.
- Delegation display only (agent_delegated renders thinking; only Mia delegates on MVP).
- No-fake-work: states change only on real bus events (`applyEvent`); the render loop only advances walkers along computed paths.

## Files

- `src/map.json` — tiles (`#` wall), spawns, PCs with stop cells.
- `src/engine.ts` — grid + deterministic A* + avatar state machine (pure, tested).
- `src/office.ts` — Phaser viewer (sprites, camera, bubbles, furniture).
- `src/panels.ts` — DOM panels + chat + SSE subscription.
- `index.html` — shell page.
