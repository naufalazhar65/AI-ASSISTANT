/**
 * Parser tests for the Google Maps live-routing prover (`gmaps.ts`).
 *
 * Fixture shapes come from a real headless load measured 2026-10-01
 * (Serpong→Bandung: "2 jam 47 mnt / 176 km / lewat Jl. Tol Cipularang").
 * The live fetch itself is proven by that session probe, not here — a
 * unit suite must never depend on Google's page.
 */

import { describe, expect, it } from "vitest";

import { GMAPS_LIVE_MARKER, gmapsDirUrl, parseGmapsDirections } from "./gmaps";

const PROBE_BODY = [
  "Terbaik",
  "2j 47m",
  "3j 57m",
  "Bandung",
  "2 jam 47 mnt",
  "176 km",
  "lewat Jl. Tol Cipularang",
  "Rute tercepat saat ini sesuai kondisi lalu lintas",
  "Rute ini melewati tol.",
  "Detail",
  "2 jam 53 mnt",
  "174 km",
  "lewat Jl. Tol Jakarta - Cikampek dan Jl. Tol Cipularang",
  "3 jam 58 mnt",
  "163 km",
  "lewat Jl. Raya Ciawi - Cianjur dan Jl. Nasional III",
].join("\n");

describe("parseGmapsDirections — route cards from directions text", () => {
  it("reads duration + distance + via per card, capped at 3", () => {
    const routes = parseGmapsDirections(PROBE_BODY);
    expect(routes).toHaveLength(3);
    expect(routes[0]).toEqual({
      duration: "2 jam 47 mnt",
      distance: "176 km",
      via: "Jl. Tol Cipularang",
    });
    expect(routes[1]?.duration).toBe("2 jam 53 mnt");
    expect(routes[2]?.distance).toBe("163 km");
  });

  it("skips the compact tab-strip times (2j 47m) — they are tabs, not cards", () => {
    const routes = parseGmapsDirections("Terbaik\n2j 47m\n3j 57m\n2 jam 47 mnt\n176 km\nlewat Tol Jagorawi");
    expect(routes).toEqual([{ duration: "2 jam 47 mnt", distance: "176 km", via: "Tol Jagorawi" }]);
  });

  it("keeps a card with a missing distance or via instead of dropping it", () => {
    expect(parseGmapsDirections("45 mnt\nlewat Jl. Sudirman")).toEqual([
      { duration: "45 mnt", distance: "", via: "Jl. Sudirman" },
    ]);
    expect(parseGmapsDirections("45 mnt\n176 km")).toEqual([
      { duration: "45 mnt", distance: "176 km", via: "" },
    ]);
  });

  it("ignores icon-glyph lines and prose without durations", () => {
    expect(parseGmapsDirections("Tambahkan tujuan\nHotel\n4,5(7.933)")).toEqual([]);
    expect(parseGmapsDirections("")).toEqual([]);
  });

  it("exposes the live-traffic marker and builds encoded dir URLs", () => {
    expect(GMAPS_LIVE_MARKER).toBe("sesuai kondisi lalu lintas");
    expect(gmapsDirUrl("Serpong", "Bandung")).toBe("https://www.google.com/maps/dir/Serpong/Bandung");
    expect(gmapsDirUrl("Jakarta Selatan", "Bogor").includes("Jakarta%20Selatan")).toBe(true);
  });
});
