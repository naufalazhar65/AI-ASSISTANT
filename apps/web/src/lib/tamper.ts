// In-browser request tamper-script generator.
//
// Why: hardened sites (Cloudflare/WAF) block programmatic replays — curl and even
// a hand-written `fetch()` from the Console get challenged, because they don't
// carry the app's own request fingerprint. The reliable way to test IDOR / mass
// assignment / parameter tampering is to let the APP send its own request and
// rewrite the body in flight: patch `window.fetch` / `XMLHttpRequest` from the
// page Console, then trigger the action in the UI. This module builds that patch
// so it is generated (and can't drift) instead of hand-written per test.

/** Field overrides: value is JSON-encoded into the body, so string/number/boolean/null all work. */
export type TamperRewrite = Record<string, unknown>;

/**
 * Build a ready-to-paste browser Console script that rewrites the JSON body of
 * any request whose URL contains `urlContains` (fetch and XHR). `set` replaces
 * existing fields; `add` appends new fields (mass assignment probes).
 */
export function buildTamperScript(opts: {
  urlContains: string;
  set?: TamperRewrite;
  add?: TamperRewrite;
}): string {
  const url = (opts.urlContains || "").trim();
  if (!url) return "Error: url_contains wajib — mis. 'UpdateUserProfile' atau '/api/profile'.";
  const set = opts.set ?? {};
  const add = opts.add ?? {};
  if (Object.keys(set).length === 0 && Object.keys(add).length === 0) {
    return "Error: isi minimal satu `set` (ganti field) atau `add` (tambah field).";
  }
  const script = `(function () {
  var URL_HAS = ${JSON.stringify(url)};
  var SET = ${JSON.stringify(set)};
  var ADD = ${JSON.stringify(add)};
  var isTarget = function (u) { return typeof u === "string" && u.indexOf(URL_HAS) !== -1; };
  var fix = function (b) {
    if (typeof b !== "string") return b;
    try {
      var o = JSON.parse(b);
      if (o && typeof o === "object") {
        Object.keys(SET).forEach(function (k) { o[k] = SET[k]; });
        Object.keys(ADD).forEach(function (k) { o[k] = ADD[k]; });
        return JSON.stringify(o);
      }
    } catch (e) {}
    return b;
  };
  var of = window.fetch;
  window.fetch = function (input, init) {
    try {
      var u = typeof input === "string" ? input : (input && input.url) || "";
      if (isTarget(u) && init && typeof init.body === "string") { init.body = fix(init.body); console.log("PATCHED fetch:", init.body); }
    } catch (e) {}
    return of.apply(this, arguments);
  };
  var open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__url = u; return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    try { if (isTarget(this.__url) && typeof body === "string") { body = fix(body); console.log("PATCHED xhr:", body); } } catch (e) {}
    return send.call(this, body);
  };
  console.log("tamper_script terpasang untuk: " + URL_HAS + " — jalankan aksi di UI, JANGAN reload; cek Console + Network response.");
})();`;
  const setKeys = Object.keys(set);
  const addKeys = Object.keys(add);
  return (
    `🧩 TAMPER SCRIPT — ${url}\n` +
    `Ganti: ${setKeys.length ? setKeys.join(", ") : "—"} | Tambah: ${addKeys.length ? addKeys.join(", ") : "—"}\n\n` +
    `Cara pakai: buka halaman app yang sudah login → F12 → Console → tempel skrip di bawah → ENTER → jalankan aksi di UI (klik Save). ` +
    `JANGAN reload setelah tempel (patch hilang). Lalu baca Network → request target → Response.\n\n` +
    "```js\n" +
    script +
    "\n```"
  );
}
