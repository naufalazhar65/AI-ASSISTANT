import { describe, expect, it } from "vitest";

import {
  buildNodeQuery,
  buildOverpassQuery,
  buildWayQuery,
  categoryFor,
  collectPlaces,
  formatPlaces,
  nameTokens,
  placeNameMatches,
  queryNameTokens,
  renderPlaces,
  type OverpassElement,
} from "./places";

describe("categoryFor", () => {
  it("routes cafe words to cafe", () => {
    expect(categoryFor("kafe tenang di Cipete")).toBe("cafe");
    expect(categoryFor("kopi dekat BSD")).toBe("cafe");
    expect(categoryFor("ngopi dimana")).toBe("cafe");
  });
  it("routes food words to restaurant", () => {
    expect(categoryFor("makan enak di Jaksel")).toBe("restaurant");
    expect(categoryFor("warung dekat sini")).toBe("restaurant");
  });
  it("falls back to both when mixed or bare", () => {
    expect(categoryFor("kafe dan resto")).toBe("both");
    expect(categoryFor("tempat nongkrong")).toBe("both");
    expect(categoryFor("")).toBe("both");
  });
  it("routes shop words to shop", () => {
    expect(categoryFor("Indomaret Fresh di Pamulang")).toBe("shop");
    expect(categoryFor("alfamart dekat sini")).toBe("shop");
    expect(categoryFor("apotek buka 24 jam")).toBe("shop");
  });
  it("routes shop+food mixed to all", () => {
    expect(categoryFor("indomaret dan kafe")).toBe("all");
    expect(categoryFor("apotek atau makan")).toBe("all");
  });
});

describe("nameTokens", () => {
  it("keeps a specific venue name, drops category/area filler", () => {
    const t = nameTokens("Turning Point Coffee di BSD");
    expect(t).toContain("turning");
    expect(t).toContain("point");
    expect(t).not.toContain("coffee"); // "coffee" is len>=4 but a category word? (documents behavior)
  });
  it("returns empty for a pure category ask", () => {
    expect(queryNameTokens("kafe tenang di Cipete", "Cipete, Jakarta Selatan")).toEqual([]);
  });
  it("keeps a venue name even when the area shares no tokens", () => {
    expect(queryNameTokens("Turning Point Coffee di BSD", "BSD")).toEqual(
      expect.arrayContaining(["turning", "point"])
    );
  });
  it("strips the generic word fresh but keeps the brand name", () => {
    const t = queryNameTokens("Indomaret Fresh di Pamulang", "Pamulang");
    expect(t).toContain("indomaret");
    expect(t).not.toContain("fresh");
  });
});

describe("placeNameMatches", () => {
  it("matches on any token, accepts all when no tokens", () => {
    expect(placeNameMatches("Turning Point Coffee", ["turning"])).toBe(true);
    expect(placeNameMatches("Fore Coffee", [])).toBe(true);
    expect(placeNameMatches("Kopi Kenangan", ["turning"])).toBe(false);
    expect(placeNameMatches("", ["turning"])).toBe(false);
  });
});

describe("buildOverpassQuery", () => {
  it("builds a bounded named-venue query", () => {
    const q = buildOverpassQuery(-6.27, 106.79, 3000, "cafe");
    expect(q).toContain("around:3000,-6.27,106.79");
    expect(q).toContain("cafe");
    expect(q).toContain('["name"]');
    expect(q).toContain("out center tags");
  });
  it("clamps radius", () => {
    expect(buildOverpassQuery(0, 0, 999999, "both")).toContain("around:20000");
    expect(buildOverpassQuery(0, 0, 10, "both")).toContain("around:500");
  });
  it("node-only is cheap (no way scan), way-only carries center", () => {
    const nq = buildNodeQuery(-6.27, 106.79, 3000, "cafe");
    expect(nq).toContain("node(around:");
    expect(nq).not.toContain("way(");
    const wq = buildWayQuery(-6.27, 106.79, 3000, "cafe");
    expect(wq).toContain("way(around:");
    expect(wq).not.toMatch(/node\(around/);
  });
  it("shop queries cover the shop key and pharmacy", () => {
    const nq = buildNodeQuery(-6.33, 106.72, 3000, "shop");
    expect(nq).toContain('["shop"~"');
    expect(nq).toContain('["amenity"="pharmacy"]');
    expect(nq).not.toContain("way(");
    const wq = buildWayQuery(-6.33, 106.72, 3000, "shop");
    expect(wq).toContain('["shop"~"');
    expect(wq).toContain('["amenity"="pharmacy"]');
    const all = buildOverpassQuery(-6.33, 106.72, 3000, "all");
    expect(all).toContain('["shop"~"');
    expect(all).toContain("cafe");
  });
});

describe("formatPlaces", () => {
  const els: OverpassElement[] = [
    { tags: { name: "Fore Coffee", amenity: "cafe", "addr:street": "Jl. Cipete Raya", "addr:housenumber": "12", opening_hours: "08:00-22:00" }, lat: -6.27, lon: 106.79 },
    { tags: { amenity: "cafe" }, lat: 0, lon: 0 }, // unnamed → skipped
    { tags: { name: "Kopi Kenangan", amenity: "cafe" }, lat: -6.28, lon: 106.8 },
  ];
  it("renders a plain numbered list, skips unnamed", () => {
    const out = formatPlaces(els, "kafe di Cipete", 8, "Cipete, Jakarta Selatan");
    expect(out).toContain("1. Fore Coffee");
    expect(out).toContain("Jl. Cipete Raya 12");
    expect(out).toContain("jam: 08:00-22:00");
    expect(out).toContain("2. Kopi Kenangan");
    expect(out).toContain("jam: tidak tercantum di peta");
    expect(out).not.toMatch(/[*#_]/);
  });
  it("filters by name tokens when the query names a venue", () => {
    const out = formatPlaces(els, "Turning Point Coffee BSD", 8, "BSD");
    expect(out).toBe("No places found.");
  });
  it("empty input is No places found.", () => {
    expect(formatPlaces([], "kafe", 8)).toBe("No places found.");
  });
  it("collect/render split: rows counted before render", () => {
    const rows = collectPlaces(els, "kafe di Cipete", "Cipete, Jakarta Selatan");
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("Fore Coffee");
    expect(renderPlaces(rows, 8)).toContain("1. Fore Coffee");
    expect(renderPlaces([], 8)).toBe("No places found.");
  });
  it("collect keeps the shop kind for convenience stores", () => {
    const shopEls: OverpassElement[] = [
      { tags: { name: "Indomaret Fresh Pamulang", shop: "convenience" }, lat: -6.33, lon: 106.72 },
    ];
    const rows = collectPlaces(shopEls, "Indomaret di Pamulang", "Pamulang");
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("convenience");
    expect(renderPlaces(rows, 8)).toContain("1. Indomaret Fresh Pamulang");
  });
});
