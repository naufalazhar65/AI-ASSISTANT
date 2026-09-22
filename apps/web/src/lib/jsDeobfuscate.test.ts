// Unit tests for js_deobfuscate pure helpers (no network). These lock the
// four transformation stages: string-array substitution, accessor-function
// resolution, concat folding, and source-map URL discovery.
import { describe, expect, it } from "vitest";
import {
  deobfuscate,
  dedupe,
  decodeCommonEscapes,
  findSourceMapUrl,
  firstStringElement,
  foldConcats,
  foldConcatsText,
  hasDeobfSignal,
  isPathLike,
  looksMinified,
  quotedSpans,
  splitTopLevel,
  unwrapChunk,
} from "./jsDeobfuscate";

describe("deobfuscate — string-array substitution", () => {
  it("replaces bracket index access", () => {
    const src = `var _0x4c2e=['fetch','/api/v2/users','POST'];console[_0x4c2e[0]](_0x4c2e[1],{method:_0x4c2e[2]});`;
    const { text, arrays } = deobfuscate(src);
    expect(arrays).toBe(1);
    expect(text).toContain('"/api/v2/users"');
    expect(text).not.toContain("_0x4c2e[");
  });

  it("replaces quoted numeric member access", () => {
    const src = `var a=['x','/admin/debug'];go(a["1"]);`;
    const { text } = deobfuscate(src);
    expect(text).toContain('"/admin/debug"');
  });

  it("replaces .at(n) access", () => {
    const src = `var a=['ok','/api/key?all=1'];hit(a.at(1));`;
    const { text } = deobfuscate(src);
    expect(text).toContain('"/api/key?all=1"');
  });

  it("handles comma-separated declarations", () => {
    const src = `var base='x',rt=['a','/api/token','c'];use(rt[1]);`;
    const { text, arrays } = deobfuscate(src);
    expect(arrays).toBe(1);
    expect(text).toContain('"/api/token"');
  });

  it("resolves the accessor-function shape (obfuscator.io)", () => {
    const src = [
      "function _0x2f1a(){const _0x3=['/api/internal/dump','login','push'];_0x2f1a=function(){return _0x3;}();return _0x2f1a();}",
      "function _0x4(b,c){const d=_0x2f1a();return _0x4=function(e,f){e=e-1;return d[e];},_0x4(b,c);}",
      "const ep=_0x4(0x0);fetch(ep);",
    ].join("\n");
    const { text, arrays } = deobfuscate(src);
    expect(arrays).toBe(1);
    expect(text).toContain('"/api/internal/dump"');
  });

  it("resolves the accessor with offset (e-0x1)", () => {
    const src = [
      "function _0x2(){const a=['unused0','/api/vault'];_0x2=function(){return a;}();return _0x2();}",
      "function _0x9(c){const d=_0x2();return _0x9=function(e){e=e-0x1;return d[e];},_0x9(c);}",
      "fetch(_0x9(0x1));",
    ].join("\n");
    const { text } = deobfuscate(src);
    expect(text).toContain('"/api/vault"');
  });

  it("resolves a plain lookup function (no offset)", () => {
    const src = [
      "var _0x1=['a','/api/direct'];",
      "function _0x3(p){return _0x1[p];}",
      "use(_0x3(1));",
    ].join("\n");
    const { text } = deobfuscate(src);
    expect(text).toContain('"/api/direct"');
  });

  it("is safe on non-obfuscated code (no false rewrite)", () => {
    const src = `const urls=['/a','/b','/c'].map(u=>fetch(u));`;
    const { text, arrays } = deobfuscate(src);
    expect(arrays).toBe(0);
    expect(text).toBe(src);
  });
});

describe("foldConcats — concat folding", () => {
  it("folds simple two-literal concat", () => {
    expect(foldConcats(`"https://api"+" /v2/users"`.replace(" /", "/"))).toBe(`"https://api/v2/users"`);
  });

  it("folds single-quoted concat", () => {
    expect(foldConcats(`'https://api'+'/v2'`)).toBe(`'https://api/v2'`);
  });

  it("folds many terms pairwise", () => {
    expect(foldConcats(`'a'+'b'+'c'+'d'`)).toBe(`'abcd'`);
  });

  it("folds unquoted identifier parts (template build-up)", () => {
    expect(foldConcatsText(`"https://"+host+"/v2/x"`)).toBe(`"https://§WS§host§WS§/v2/x"`.replaceAll("§WS§", " + "));
  });

  it("keeps numeric addition intact", () => {
    expect(foldConcats(`"n="+1+2`)).toBe(`"n="+1+2`);
  });

  it("folds across lines", () => {
    expect(foldConcats(`fetch(\n  'https://api.x.io'\n  + '/v2/users'\n);`)).toContain(`'https://api.x.io/v2/users'`);
  });
});

describe("unwrapChunk / decodeCommonEscapes", () => {
  it("unwraps JSON.parse('…')", () => {
    expect(unwrapChunk(`JSON.parse('{"a":1}')`)).toBe(`'{"a":1}'`);
  });

  it("decodes hex escapes", () => {
    expect(decodeCommonEscapes("/api\\x2Fsecure")).toBe("/api/secure");
  });

  it("decodes unicode escapes", () => {
    expect(decodeCommonEscapes("\\u002Fadmin")).toBe("/admin");
  });
});

describe("splitTopLevel / firstStringElement", () => {
  it("splits only at depth 0", () => {
    expect(splitTopLevel(`'a'+f('b'+'c')+'d'`)).toEqual([`'a'`, `f('b'+'c')`, `'d'`]);
  });

  it("extracts the first string literal", () => {
    expect(firstStringElement(`  '/api/x' `)).toBe(`/api/x`);
  });
});

describe("isPathLike", () => {
  it("accepts endpoints", () => {
    expect(isPathLike("/api/v2/users")).toBe(true);
    expect(isPathLike("/debug?all=1")).toBe(true);
    expect(isPathLike("https://cdn.example.com/x")).toBe(true);
  });

  it("rejects assets and junk", () => {
    expect(isPathLike("/logo.png")).toBe(false);
    expect(isPathLike("/app.js.map")).toBe(false);
    expect(isPathLike("hello world")).toBe(false);
    expect(isPathLike("")).toBe(false);
  });
});

describe("findSourceMapUrl", () => {
  it("finds the inline sourceMappingURL comment", () => {
    const body = `//# sourceURL=bundle.js\n//# sourceMappingURL=app.1234.js.map\n`;
    expect(findSourceMapUrl("https://x.com/assets/app.1234.js", body)).toBe("https://x.com/assets/app.1234.js.map");
  });

  it("prefers an explicit inline map over the adjacent guess (audit 2026-09-23)", () => {
    const body = `console.log(1);\n//# sourceMappingURL=other.map\n`;
    // Adjacent guess would be custom.js.map — the explicit line form must win.
    expect(findSourceMapUrl("https://x.com/a/custom.js", body)).toBe("https://x.com/a/other.map");
  });

  it("falls back to the adjacent .js.map", () => {
    expect(findSourceMapUrl("https://x.com/a/bundle.js", "")).toBe("https://x.com/a/bundle.js.map");
  });

  it("handles .mjs bundles", () => {
    expect(findSourceMapUrl("https://x.com/a/b.mjs", "")).toBe("https://x.com/a/b.js.map");
  });

  it("returns null for non-JS urls", () => {
    expect(findSourceMapUrl("https://x.com/a/style.css", "")).toBe(null);
  });
});

describe("looksMinified / hasDeobfSignal / dedupe", () => {
  it("detects minified bundles", () => {
    expect(looksMinified("a".repeat(5000))).toBe(true);
    expect(looksMinified("short\nlines\nhere\n")).toBe(false);
  });

  it("detects leftover obfuscation", () => {
    expect(hasDeobfSignal(`var _0x1a2b3c=[]`)).toBe(true);
    expect(hasDeobfSignal(`"/api/clear" + "\\x2F" + "all"`)).toBe(true);
    expect(hasDeobfSignal(`const clear = "/api/clear"`)).toBe(false);
  });

  it("dedupes preserving order", () => {
    expect(dedupe(["a", "b", "a"])).toEqual(["a", "b"]);
  });
});

describe("quotedSpans (audit 2026-09-23: no rewrites inside string literals)", () => {
  it("leaves string content alone during array substitution", () => {
    const src = `var _0x4c2e=['/api/real','POST'];var s="use _0x4c2e[0] here";go(_0x4c2e[0]);`;
    const { text } = deobfuscate(src);
    expect(text).toContain('"/api/real"');
    expect(text).toContain('"use _0x4c2e[0] here"');
  });

  it("quotedSpans finds double/single/backtick spans", () => {
    const spans = quotedSpans(`a("x") + 'y' + \`z\``);
    expect(spans.length).toBe(3);
  });
});
