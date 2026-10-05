/**
 * Pixel-office Phaser viewer: room scene + avatar sprites + emote bubbles.
 * No framework. Phaser comes from CDN (see index.html); this module only
 * declares the global. Game state comes from the shared engine (engine.ts)
 * advanced on a fixed tick; rendering lerps sprites toward engine cells.
 * Panels (panels.ts) drive selection/inspection via window hooks.
 */
import { applyEvent, initialState, isWalkable, parseMap, stepOffice, } from "./engine.js";
import { emoteFor } from "./panels.js";
const TILE = 32;
const STEP_MS = 150;
const FOLLOW_ZOOM = 1.6;
const AGENT_ORDER = ["mia", "agnes", "michelle"];
const views = new Map();
let followed = null;
function agentColor(id) {
    if (id === "mia")
        return 0xff6d8d;
    if (id === "agnes")
        return 0x6aa8ff;
    if (id === "michelle")
        return 0x5bd68a;
    return 0x8a8f99;
}
function makeBodyTexture(scene, id) {
    const key = `body-${id}`;
    if (scene.textures.exists(key))
        return;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    const c = agentColor(id);
    g.fillStyle(0x0b0e14, 1);
    g.fillRoundedRect(0, 0, 20, 24, 7);
    g.fillStyle(c, 1);
    g.fillRoundedRect(2, 2, 16, 20, 6);
    // Pixel shine: two light squares top-left.
    g.fillStyle(0xffffff, 0.55);
    g.fillRect(5, 5, 3, 3);
    g.fillRect(9, 9, 2, 2);
    g.generateTexture(key, 20, 24);
    g.destroy();
}
/** Tiny black eyes drawn as one shared texture, positioned per avatar. */
function makeFaceTexture(scene) {
    if (scene.textures.exists("face"))
        return;
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0x111111, 1);
    g.fillRect(0, 0, 3, 4);
    g.fillRect(7, 0, 3, 4);
    g.generateTexture("face", 10, 4);
    g.destroy();
}
export function bootOffice(canvas, map, state) {
    const W = map.width * TILE;
    const H = map.height * TILE;
    const config = {
        // Explicit CANVAS (never AUTO): Phaser's auto-detect throws "Must set
        // explicit renderType in custom environment" where detection fails, and
        // our pixel rendering is plain 2D — CANVAS is deterministic everywhere.
        type: Phaser.CANVAS,
        canvas,
        width: W,
        height: H,
        backgroundColor: "#0b0e14",
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
        scene: { create: createScene, update: updateScene },
    };
    const game = new Phaser.Game(config);
    game.__office = { map, state };
    function createScene() {
        const scene = this;
        const { map: m, state: st } = scene.game.__office;
        makeFaceTexture(scene);
        // Floor + walls from the map grid.
        for (let y = 0; y < m.height; y++) {
            for (let x = 0; x < m.width; x++) {
                const wall = m.tiles[y][x] === "#";
                const r = scene.add.rectangle(x * TILE + TILE / 2, y * TILE + TILE / 2, TILE - 1, TILE - 1, wall ? 0x232936 : (x + y) % 2 === 0 ? 0x141821 : 0x171c26);
                r.setOrigin(0.5);
                if (wall) {
                    const hi = scene.add.rectangle(x * TILE + TILE / 2, y * TILE + 2, TILE - 1, 3, 0x2e3648);
                    hi.setOrigin(0.5);
                    const sh = scene.add.rectangle(x * TILE + TILE / 2, y * TILE + TILE - 2, TILE - 1, 2, 0x10131a);
                    sh.setOrigin(0.5);
                }
            }
        }
        // Furniture: a desk + monitor on every PC tile (decorative; walkability
        // comes from the engine, never from visuals).
        for (const pc of m.pcs) {
            const cx = pc.x * TILE + TILE / 2;
            const cy = pc.y * TILE + TILE / 2;
            scene.add.rectangle(cx, cy + 6, 26, 10, 0x4a3525).setOrigin(0.5);
            const screen = scene.add.rectangle(cx, cy - 4, 18, 12, 0x0e1420).setOrigin(0.5);
            screen.setData("pcId", pc.id);
            screen.setData("screen", true);
            scene.add.rectangle(cx, cy - 8, 18, 2, 0x1d4e5e).setOrigin(0.5);
            const label = scene.add
                .text(cx, cy + 16, pc.id, { fontSize: "9px", color: "#8A8F99", fontFamily: "monospace" })
                .setOrigin(0.5);
            label.setData("pcId", pc.id);
        }
        // Decor: rug, plants, bookshelf, pantry + zone labels (pure visuals;
        // walkability comes from the engine, never from decor — same precedent
        // as the desks above).
        const decor = (x, y, w, h, color) => {
            scene.add
                .rectangle(x * TILE + TILE / 2, y * TILE + TILE / 2, w * TILE - 2, h * TILE - 2, color)
                .setOrigin(0.5);
        };
        // Lounge rug under/around the central table.
        decor(7, 5, 6, 4, 0x2a1f16);
        decor(7, 5, 6, 1, 0x33261c);
        // Corner plants: pot + leaves + highlight.
        for (const [px, py] of [[1, 1], [18, 1]]) {
            const cx = px * TILE + TILE / 2;
            const cy = py * TILE + TILE / 2;
            scene.add.rectangle(cx, cy + 8, 12, 8, 0x6b4a2f).setOrigin(0.5);
            scene.add.rectangle(cx, cy - 2, 14, 12, 0x2f7d3a).setOrigin(0.5);
            scene.add.rectangle(cx - 3, cy - 5, 4, 4, 0x46a551).setOrigin(0.5);
        }
        // Bookshelf along the top wall + colored spines.
        scene.add.rectangle(6 * TILE, 10, 3 * TILE, 14, 0x4a3525).setOrigin(0, 0.5);
        for (const [i, c] of [0xc0392b, 0x2980b9, 0x27ae60, 0xf39c12, 0x8e44ad, 0x16a085].entries()) {
            scene.add.rectangle(6 * TILE + 6 + i * 12, 10, 8, 10, c).setOrigin(0.5);
        }
        // Pantry counter over the right wall + coffee cups.
        scene.add.rectangle(19 * TILE + TILE / 2, 4 * TILE, TILE - 2, TILE - 2, 0x3a3f4a).setOrigin(0.5);
        scene.add.rectangle(19 * TILE + TILE / 2, 5 * TILE, TILE - 2, TILE - 2, 0x3a3f4a).setOrigin(0.5);
        scene.add.rectangle(19 * TILE + TILE / 2 - 5, 4 * TILE, 6, 6, 0xd8d3c3).setOrigin(0.5);
        scene.add.rectangle(19 * TILE + TILE / 2 + 5, 5 * TILE, 6, 6, 0xd8d3c3).setOrigin(0.5);
        // Table-top clutter on the central table (decorative).
        scene.add.rectangle(9 * TILE, 6 * TILE + 10, 22, 12, 0x5a4632).setOrigin(0.5);
        scene.add.rectangle(9 * TILE - 4, 6 * TILE + 8, 8, 6, 0xd8d3c3).setOrigin(0.5);
        scene.add.rectangle(10 * TILE + 2, 7 * TILE - 6, 6, 8, 0x7fb3d5).setOrigin(0.5);
        // Pendant lights over the lounge rug.
        scene.add.rectangle(9 * TILE, 5 * TILE - 6, 5, 5, 0xf5d76e).setOrigin(0.5);
        scene.add.rectangle(11 * TILE, 5 * TILE - 6, 5, 5, 0xf5d76e).setOrigin(0.5);
        // Corner plants, bottom row.
        for (const [px, py] of [[1, 10], [18, 10]]) {
            const qx = px * TILE + TILE / 2;
            const qy = py * TILE + TILE / 2;
            scene.add.rectangle(qx, qy + 8, 12, 8, 0x6b4a2f).setOrigin(0.5);
            scene.add.rectangle(qx, qy - 2, 14, 12, 0x2f7d3a).setOrigin(0.5);
        }
        // Fridge against the right wall, below the pantry.
        scene.add.rectangle(19 * TILE + TILE / 2, 6 * TILE + TILE / 2, TILE - 4, 2 * TILE - 4, 0x9aa0a8).setOrigin(0.5);
        scene.add.rectangle(19 * TILE - 2, 6 * TILE + 2, 3, 10, 0x5b6169).setOrigin(0.5);
        // Zone labels.
        const zone = (x, y, text) => {
            scene.add
                .text(x * TILE + TILE / 2, y * TILE + TILE / 2, text, {
                fontSize: "9px",
                color: "#5b6472",
                fontFamily: "monospace",
            })
                .setOrigin(0.5);
        };
        zone(13, 0, "DEV AREA");
        zone(10, 8, "LOUNGE");
        zone(18, 4, "PANTRY");
        // Avatars for whoever the engine knows (trio pre-seeded + on-demand).
        syncAvatars(scene, m, st);
        // Click avatar → follow + inspect; click empty → stop following.
        scene.input.on("pointerdown", (p) => {
            const wx = p.worldX;
            const wy = p.worldY;
            let hit = null;
            for (const [id, v] of views) {
                if (Math.abs(v.px - wx) < 14 && Math.abs(v.py - wy) < 16) {
                    hit = id;
                    break;
                }
            }
            followed = hit;
            const cam = scene.cameras.main;
            if (hit) {
                cam.startFollow(views.get(hit).body, false, 0.12, 0.12);
                cam.setZoom(FOLLOW_ZOOM);
            }
            else {
                cam.stopFollow();
                cam.setZoom(1);
                cam.centerOn(W / 2, H / 2);
            }
            const sel = window.__officeSelect;
            if (typeof sel === "function") {
                try {
                    sel(hit);
                }
                catch {
                    /* selection is best-effort */
                }
            }
        });
        // Engine tick: advance walkers, then sync visuals.
        setInterval(() => {
            stepOffice(st, m);
            syncAvatars(scene, m, st);
            const snap = window.__officeSnapshot;
            if (typeof snap === "function") {
                try {
                    snap(avatarSnapshot(st));
                }
                catch {
                    /* snapshot is best-effort */
                }
            }
        }, STEP_MS);
    }
    function updateScene() {
        // Smooth glide toward engine cells (visual only; truth stays in engine).
        const k = 0.25;
        for (const [, v] of views) {
            v.body.x += (v.px - v.body.x) * k;
            v.body.y += (v.py - v.body.y) * k;
            v.face.x = v.body.x - 5;
            v.face.y = v.body.y - 3;
            v.name.x = v.body.x;
            v.name.y = v.body.y + 16;
            v.emote.x = v.body.x;
            v.emote.y = v.body.y - 20;
        }
    }
}
function avatarSnapshot(state) {
    return Object.entries(state.avatars).map(([id, a]) => ({ id, status: a.status, station: a.station }));
}
function syncAvatars(scene, map, state) {
    for (const [id, a] of Object.entries(state.avatars)) {
        makeBodyTexture(scene, id);
        let v = views.get(id);
        const tx = a.pos.x * TILE + TILE / 2;
        const ty = a.pos.y * TILE + TILE / 2;
        if (!v) {
            const body = scene.add.image(tx, ty, `body-${id}`);
            const face = scene.add.image(tx - 5, ty - 3, "face");
            const name = scene.add
                .text(tx, ty + 16, id, { fontSize: "10px", color: "#c8cdd6", fontFamily: "monospace" })
                .setOrigin(0.5);
            const emote = scene.add
                .text(tx, ty - 20, emoteFor(a.status), { fontSize: "13px" })
                .setOrigin(0.5);
            v = { body, face, name, emote, px: tx, py: ty };
            views.set(id, v);
        }
        v.px = tx;
        v.py = ty;
        const want = emoteFor(a.status);
        if (v.emote.text !== want)
            v.emote.setText(want);
        // Furniture interaction visual: the occupied PC screen glows.
        scene.children.each((child) => {
            if (child.getData && child.getData("screen")) {
                const pcId = child.getData("pcId");
                const busy = a.station === pcId && (a.status === "working" || a.status === "typing");
                child.setFillStyle(busy ? 0x22d3ee : 0x0e1420, 1);
            }
            return true;
        });
        void map;
    }
}
/** Boot from fetched map.json. Exported for panels/tests wiring. */
export async function bootFromMap(canvas) {
    const res = await fetch("map.json");
    if (!res.ok)
        throw new Error(`map.json ${res.status}`);
    const map = parseMap(await res.json());
    const state = initialState(map);
    bootOffice(canvas, map, state);
    window.__officeApply = (ev) => applyEvent(state, map, ev);
    void isWalkable;
    return { map, state };
}
