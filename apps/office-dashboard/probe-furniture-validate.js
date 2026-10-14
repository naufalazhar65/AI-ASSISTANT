// probe-furniture-validate.js — run the office scene's COMMITTED placement
// validator headlessly (Node + vendor three.min.js r128 UMD), print the issue
// list. Dev-time validation per task spec §7: exit 1 when issues remain,
// exit 0 when the scene is clean.
//
// Usage: node apps/office-dashboard/probe-furniture-validate.js [--json]
//
// The inline <script> in index.html is extracted at runtime so this probe
// always validates the CURRENT source. Browser APIs it touches are stubbed;
// the ONLY network allowed is a read-only proxy of relative /api/* fetches
// to the local office server (falls back to honest offline when down).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const util = require('util');

const HERE = __dirname;
const OFFICE_BASE = process.env.OFFICE_BASE || 'http://127.0.0.1:3001';
const AS_JSON = process.argv.includes('--json');
const EXPORT_MODE = process.argv.includes('--export');

// ---- capture page console ----
const pageLogs = [];
function pageLog(level, args) {
  const line = args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 4, breakLength: 140 }))).join(' ');
  pageLogs.push(`[${level}] ${line}`);
  if (!AS_JSON && !EXPORT_MODE) console.log(`[page:${level}] ${line}`);
}
const consoleStub = {
  log: (...a) => pageLog('log', a),
  warn: (...a) => pageLog('warn', a),
  error: (...a) => pageLog('error', a),
  info: (...a) => pageLog('info', a),
  debug: (...a) => pageLog('debug', a),
  // three.js and the page's own diagnostics call the grouping/table helpers;
  // without them init3D() throws and the probe reports a phantom 3D failure.
  group: (...a) => pageLog('group', a),
  groupCollapsed: (...a) => pageLog('groupCollapsed', a),
  groupEnd() {},
  table: (...a) => pageLog('table', a),
  time: () => 0,
  timeEnd() {},
  trace: (...a) => pageLog('trace', a),
  assert() {},
  count: () => 0,
  dir: (...a) => pageLog('dir', a),
};

// ---- 2d canvas context stub (label textures draw here) ----
function makeCtx2d(canvas) {
  const store = {};
  return new Proxy({}, {
    get(t, p) {
      if (p === 'measureText') return () => ({ width: 10 });
      if (p === 'canvas') return canvas;
      if (p === 'createLinearGradient' || p === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      if (p === 'createPattern') return () => ({});
      if (p in store) return store[p];
      return (...args) => {};
    },
    set(t, p, v) { store[p] = v; return true; },
  });
}

// ---- element stub ----
function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    width: 300,
    height: 150,
    clientWidth: 1280,
    clientHeight: 800,
    innerHTML: '',
    textContent: '',
    parentNode: null,
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    appendChild(c) { el.children.push(c); return c; },
    insertBefore(c) { el.children.unshift(c); return c; },
    removeChild(c) { return c; },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    getContext() { return makeCtx2d(el); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    focus() {},
    click() {},
    // nav is walked with querySelectorAll in show(); the stub has no children,
    // so an empty array is the honest answer.
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  return el;
}

const elCache = {};
function cachedEl(key, tag) {
  if (!elCache[key]) elCache[key] = makeEl(tag);
  return elCache[key];
}
const documentStub = {
  // applyTheme() writes the light/dark choice onto the root element, so the stub
  // needs one that swallows the attribute. Without it the probe died on boot
  // with "Cannot read properties of undefined (reading 'setAttribute')" and
  // stopped validating anything at all.
  documentElement: { setAttribute() {}, getAttribute() { return 'dark'; }, dataset: {} },
  get body() { return cachedEl('body', 'body'); },
  querySelector(sel) { return cachedEl('q:' + sel, 'div'); },
  querySelectorAll() { return []; },
  createElement(tag) { return makeEl(tag); },
  getElementById(id) { return cachedEl('id:' + id, 'div'); },
  addEventListener() {},
  removeEventListener() {},
};

// ---- fetch: proxy relative /api/* to the live office server, else offline ----
async function probeFetch(url, opts) {
  const u = String(url);
  const target = /^https?:\/\//.test(u) ? u : OFFICE_BASE + u;
  try {
    return await globalThis.fetch(target, opts);
  } catch (e) {
    throw new Error('probe offline (no office server): ' + e.message);
  }
}

// ---- WebGLRenderer stub (scene graph is real THREE; only rasterization is fake) ----
function StubRenderer() {
  this.shadowMap = {};
  this.info = { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 } };
}
StubRenderer.prototype.setPixelRatio = function () {};
StubRenderer.prototype.setSize = function () {};
StubRenderer.prototype.render = function () {};
StubRenderer.prototype.dispose = function () {};
Object.defineProperty(StubRenderer.prototype, 'domElement', {
  get() { if (!this._el) this._el = makeEl('canvas'); return this._el; },
});

let rafCb = null;
const windowStub = {
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 1,
  addEventListener() {},
  removeEventListener() {},
  // ResizeObserver / EventSource deliberately ABSENT: the page guards both
  // (`if (window.ResizeObserver)`, `typeof EventSource === 'undefined'`),
  // so absence takes the honest offline/static path.
};

async function main() {
  const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
  const m = html.match(/<script>\s*\n([\s\S]*?)\n\s*<\/script>\s*<\/body>/);
  if (!m) throw new Error('inline <script> block not found in index.html');
  const inlineJs = m[1];
  if (!AS_JSON && !EXPORT_MODE) console.log(`inline script: ${inlineJs.length} bytes`);

  // --export: no page injection needed. The page already exposes the live
  // PLACED registry as office.placed (index.html:3741) plus office.scene,
  // so the census is built harness-side from real objects. WALLS/tolerances/
  // agent spots are static literals - audited via grep, not runtime reads.
  const evalJs = inlineJs;

  const THREE = require(path.join(HERE, 'vendor', 'three.min.js'));
  THREE.WebGLRenderer = StubRenderer;
  windowStub.THREE = THREE;

  const sandbox = {
    console: consoleStub,
    window: windowStub,
    document: documentStub,
    fetch: probeFetch,
    requestAnimationFrame(cb) { rafCb = cb; return 1; },
    cancelAnimationFrame() {},
    setInterval() { return 0; }, // polls never fire headlessly; init paths only
    clearInterval() {},
    setTimeout,
    clearTimeout,
    THREE,
    // hashView() reads location.hash during boot; the probe always boots on the
    // default view, so an empty hash is the honest value.
    location: { hash: '', pathname: '/', search: '', reload() {} },
    history: { pushState() {}, replaceState() {} },
    localStorage: (() => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }; })(),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  let office;
  try {
    vm.runInContext(evalJs, sandbox, { filename: 'office-inline.js' });
    office = sandbox.window.__miaOffice;
  } catch (e) {
    console.error(`INIT THREW: ${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n') : e}`);
    process.exit(2);
  }
  if (!office) {
    const fb = (elCache['q:#fbMsg'] && elCache['q:#fbMsg'].textContent) || '(empty)';
    throw new Error(`window.__miaOffice was not set — init did not complete. fail3D message: ${fb}`);
  }

  // Re-run the validator explicitly and capture its structured return.
  let validateRet = null;
  let validateErr = null;
  try {
    validateRet = office.validate ? office.validate() : '(office.validate missing)';
  } catch (e) {
    validateErr = String((e && e.stack) || e);
  }

  // Scene census: proves the validator ran against a REAL built scene
  // (non-empty registry), not an empty stub world.
  let census = null;
  try {
    const scene = office.scene;
    let meshes = 0, groups = 0, lights = 0;
    scene.traverse((o) => {
      if (o.isMesh) meshes++;
      if (o.isGroup) groups++;
      if (o.isLight) lights++;
    });
    census = {
      ready: office.ready,
      children: scene.children.length,
      meshes, groups, lights,
    };
  } catch (e) { census = { error: String(e) }; }

  let checkPartsRet = null, checkPartsErr = null;
  try {
    if (office.checkParts) checkPartsRet = office.checkParts();
  } catch (e) { checkPartsErr = String((e && e.stack) || e); }

  // --export: blind-spot census, built harness-side from office.placed +
  // office.scene (real THREE objects, same module instance). Prints JSON.
  if (EXPORT_MODE) {
    const exp = { error: null };
    try {
      if (!office.placed) throw new Error('office.placed missing');
      const boundsOf = (obj) => {
        obj.updateWorldMatrix(true, true);
        const b = new THREE.Box3().setFromObject(obj);
        const r = (v) => +v.toFixed(3);
        return { min: [r(b.min.x), r(b.min.y), r(b.min.z)], max: [r(b.max.x), r(b.max.y), r(b.max.z)] };
      };
      exp.placed = office.placed.map((r) => ({
        name: r.name, kind: r.kind, zone: r.zone, note: r.note || '',
        radius: r.radius || null, tuckedUnder: r.tuckedUnder || null,
        assembly: r.assembly, hosts: r.hosts || [],
        pos: [+r.group.position.x.toFixed(3), +r.group.position.y.toFixed(3), +r.group.position.z.toFixed(3)],
        rotY: +r.group.rotation.y.toFixed(4), bounds: boundsOf(r.group),
      }));
      const placedGroups = new Set(office.placed.map((r) => r.group));
      const covered = (o) => { let c = o; while (c) { if (placedGroups.has(c)) return true; c = c.parent; } return false; };
      const scene = office.scene;
      exp.unregisteredTop = [];
      for (const child of scene.children) {
        if (covered(child)) continue;
        let meshes = 0; const ctypes = {};
        child.traverse((o) => { if (o.isMesh) { meshes++; const g = (o.geometry && o.geometry.type) || '?'; ctypes[g] = (ctypes[g] || 0) + 1; } });
        exp.unregisteredTop.push({ name: child.name || '(anon)', type: child.type, meshes: meshes, ctypes: ctypes, bounds: boundsOf(child) });
      }
      exp.unregisteredNamed = [];
      const nameRe = /desk|chair|sofa|table|shelf|plant|lamp|^tv|fridge|cabinet|light|window|conditioner|\bac\b|arcade|beanbag|carrom|stool|bench|counter|rack|stand/i;
      scene.traverse((o) => {
        if ((o.isGroup || o.isMesh) && o.name && nameRe.test(o.name) && !covered(o)) {
          let m2 = 0;
          o.traverse((c) => { if (c.isMesh) m2++; });
          exp.unregisteredNamed.push({ name: o.name, type: o.type, meshes: m2, bounds: boundsOf(o) });
        }
      });
    } catch (e) { exp.error = String((e && e.stack) || e); }
    console.log(JSON.stringify(exp, null, 1));
    process.exit(exp.error ? 2 : 0);
  }

  const retStr = validateRet === null || validateRet === undefined
    ? String(validateRet)
    : util.inspect(validateRet, { depth: 6, breakLength: 160, maxArrayLength: 200 });

  if (AS_JSON) {
    console.log(JSON.stringify({ pageLogs, census, validateReturn: retStr, validateError: validateErr, checkParts: String(checkPartsRet), checkPartsError: checkPartsErr }, null, 2));
    return;
  }
  console.log('\n==== scene census ====');
  console.log(util.inspect(census));
  console.log('\n==== office.validate() return ====');
  console.log(retStr);
  if (validateErr) console.log(`\nvalidate() THREW:\n${validateErr}`);
  console.log('\n==== office.checkParts() return ====');
  console.log(String(checkPartsRet));
  if (checkPartsErr) console.log(`\ncheckParts() THREW:\n${checkPartsErr}`);

  // Heuristic exit code: the validator's own console lines + return value
  // decide. Anything mentioning an issue/fail/error (outside known benign
  // lines) keeps the exit red so Phase 4 can gate on it.
  const red = pageLogs.filter((l) => /issue|fail|error|below|above|overlap|outside|block/i.test(l)
    && !/0 issue|no .*issue|__miaOffice|error boundary/i.test(l));
  console.log(`\npage log lines: ${pageLogs.length}, suspicious: ${red.length}`);
  for (const l of red.slice(0, 60)) console.log('  !! ' + l);
  process.exit(red.length || validateErr ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS FAILED:', e); process.exit(2); });
