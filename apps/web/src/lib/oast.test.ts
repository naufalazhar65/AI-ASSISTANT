// OAST auto-watch — pure helpers (dedupe, attribution, merge caps, hit-count
// parser). No network, no disk.
import { describe, it, expect } from "vitest";
import { oastHitId, newHits, attributeCarriers, toHit, mergeHits, oastHitCount } from "./oast";

describe("oastHitId", () => {
  it("prefers webhook.site request uuid", () => {
    expect(oastHitId({ uuid: "abc-123", method: "GET" })).toBe("abc-123");
  });
  it("falls back to method|created_at|url when uuid missing", () => {
    expect(oastHitId({ method: "POST", created_at: "2026-09-23T00:00:00Z", url: "https://webhook.site/x" }))
      .toBe("POST|2026-09-23T00:00:00Z|https://webhook.site/x");
  });
});

describe("newHits (dedupe against seen)", () => {
  const rows = [{ uuid: "a" }, { uuid: "b" }, { uuid: "c" }];
  it("returns all rows when nothing seen yet", () => {
    expect(newHits(rows, []).length).toBe(3);
  });
  it("drops already-seen ids, preserves order", () => {
    expect(newHits(rows, ["a", "c"]).map((r) => r.uuid)).toEqual(["b"]);
  });
  it("empty rows → empty", () => {
    expect(newHits([], ["a"])).toEqual([]);
  });
});

describe("attributeCarriers (http-history lookup)", () => {
  const history = [
    { method: "GET", url: "http://other.example/", status: 200, bytes: 1, ms: 0, at: "" },
    { method: "GET", url: "http://lab/fetch?url=https://webhook.site/uuid-1", status: 200, bytes: 1, ms: 0, at: "" },
    { method: "POST", url: "http://lab2/upload", status: 200, bytes: 1, ms: 0, at: "" },
  ];
  it("finds the record whose url carries the token uuid", () => {
    const c = attributeCarriers("uuid-1", history);
    expect(c.length).toBe(1);
    expect(c[0].url).toContain("lab/fetch");
  });
  it("returns empty when no record carries it (POST-body payload)", () => {
    expect(attributeCarriers("uuid-none", history)).toEqual([]);
  });
  it("empty uuid → empty", () => {
    expect(attributeCarriers("", history)).toEqual([]);
  });
  it("caps at 3 newest carriers", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      method: "GET", url: `http://lab?p=${i}&cb=https://webhook.site/u9`, status: 200, bytes: 1, ms: 0, at: "",
    }));
    expect(attributeCarriers("u9", many).length).toBe(3);
  });
});

describe("toHit", () => {
  it("records method/path/ip + carriers", () => {
    const h = toHit({ uuid: "r1", method: "GET", url: "https://webhook.site/tok/x.js?c=1", ip: "1.2.3.4", created_at: "T" }, ["http://lab/x"]);
    expect(h.id).toBe("r1");
    expect(h.path).toBe("/tok/x.js?c=1");
    expect(h.ip).toBe("1.2.3.4");
    expect(h.carriers).toEqual(["http://lab/x"]);
  });
});

describe("mergeHits (store merge + caps)", () => {
  it("dedupes ids already in hits and prepends new ones", () => {
    const store = mergeHits({ seen: [], hits: [{ id: "h0", at: "", method: "GET", path: "/old", ip: "?", carriers: [] }] }, [{ uuid: "h0" }, { uuid: "h1" }], ["http://lab"]);
    expect(store.hits!.map((h) => h.id)).toEqual(["h1", "h0"]);
    expect(store.seen).toEqual(["h0", "h1"]);
  });
  it("no fresh rows → store untouched", () => {
    const s = { seen: ["x"], hits: [] };
    expect(mergeHits(s, [], [])).toBe(s);
  });
  it("caps hits at 100", () => {
    const old = Array.from({ length: 100 }, (_, i) => ({ id: `o${i}`, at: "", method: "GET", path: "/", ip: "?", carriers: [] }));
    const store = mergeHits({ hits: old, seen: [] }, [{ uuid: "new1" }], []);
    expect(store.hits!.length).toBe(100);
    expect(store.hits![0].id).toBe("new1");
  });
});

describe("oastHitCount (the ONLY oast_poll parser)", () => {
  it("parses the with-hits head (fresh marker)", () => {
    expect(oastHitCount("🎣 OAST https://webhook.site/u — 3 hit (2 BARU sejak cek terakhir):")).toBe(3);
  });
  it("parses the with-hits head (no-new variant)", () => {
    expect(oastHitCount("🎣 OAST https://webhook.site/u — 7 hit (tidak ada yang baru):")).toBe(7);
  });
  it("no-hit reply → 0", () => {
    expect(oastHitCount("🎣 OAST https://webhook.site/u — belum ada interaksi (0 hit). Kalau target blind, cek lagi nanti / pastikan payload benar-benar terkirim.")).toBe(0);
  });
  it("error / no-token / old dead-format → 0", () => {
    expect(oastHitCount("Error: gagal polling")).toBe(0);
    expect(oastHitCount("Belum ada OAST aktif — jalankan `oast_create` dulu.")).toBe(0);
    expect(oastHitCount("🎣 OAST … — 3 interaksi (3 terbaru):")).toBe(0); // pre-fix format
    expect(oastHitCount("1 request diterima")).toBe(0);
  });
});
