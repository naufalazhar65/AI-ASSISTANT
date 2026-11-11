/* Unit tests for the human activity map (apps/office-dashboard/activity.cjs).
 * The dashboard server is CommonJS, so the module is CommonJS too; this ESM
 * test reaches it through createRequire. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { toolName, humanActivity } = require("./activity.cjs");

test("toolName strips the tool: prefix and keeps other actions intact", () => {
  assert.equal(toolName("tool:google_news"), "google_news");
  assert.equal(toolName("tool:findings::add"), "findings::add");
  assert.equal(toolName("turn_provider"), "turn_provider");
  assert.equal(toolName(null), "");
});

test("a known tool becomes a human sentence, never the identifier", () => {
  assert.equal(humanActivity("tool:google_news"), "melakukan riset");
  assert.equal(humanActivity("tool:file_read"), "membaca berkas");
  assert.equal(humanActivity("tool:exec"), "menjalankan perintah");
  assert.equal(humanActivity("tool:write_file"), "menulis kode");
  assert.equal(humanActivity("tool:calculate"), "menghitung");
  assert.equal(humanActivity("tool:remind_me"), "mengatur pengingat");
  assert.equal(humanActivity("tool:gmail_list"), "membaca email");
  assert.equal(humanActivity("tool:spotify_play"), "memutar musik");
  assert.equal(humanActivity("tool:finding_add"), "memeriksa keamanan");
});

test("an unknown tool falls back to its family, then to a neutral phrase", () => {
  assert.equal(humanActivity("tool:some_new_searcher"), "melakukan riset");
  assert.equal(humanActivity("tool:some_new_scanner"), "menjalankan pengujian");
  assert.equal(humanActivity("tool:totally_unknown_thing"), "bekerja");
});

test("a non-tool action has no activity phrase of its own", () => {
  assert.equal(humanActivity("turn_provider"), "");
  assert.equal(humanActivity("turn_error"), "");
  assert.equal(humanActivity(""), "");
});

test("no phrase ever leaks a raw identifier", () => {
  const names = [
    "google_news", "file_read", "write_file", "exec", "xss_hunt", "csrf_prove",
    "smuggle_probe", "upload_fuzz", "mass_assignment", "pentest_skill_route",
    "threat_model", "coverage", "web_audit", "totally_unknown_thing"
  ];
  for (const n of names) {
    const phrase = humanActivity("tool:" + n);
    assert.ok(phrase.length > 0, "phrase for " + n);
    assert.ok(!/[a-z]+_[a-z]+/.test(phrase), "phrase must not contain an identifier: " + phrase);
    assert.ok(!phrase.includes(n), "phrase must not contain the tool name: " + phrase);
  }
});
