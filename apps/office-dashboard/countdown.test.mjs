import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Mia = require('./countdown.js');

/* The release moment is stated in WIB, so the expected value is recomputed
   independently of the module: 2026-11-19 00:00 +07:00 == 2026-11-18 17:00 UTC. */
const EXPECTED_TARGET = Date.UTC(2026, 10, 18, 17, 0, 0);

test('the release target is 19 November 2026 00:00 WIB', () => {
  assert.equal(Mia.TARGET_ISO, '2026-11-19T00:00:00+07:00');
  assert.equal(Mia.targetMs(), EXPECTED_TARGET);
});

test('parts break the remaining time into days, hours, minutes and seconds', () => {
  const p = Mia.parts(EXPECTED_TARGET - (((2 * 86400) + (3 * 3600) + (4 * 60) + 5)) * 1000);
  assert.equal(p.released, false);
  assert.equal(p.days, 2);
  assert.equal(p.hours, 3);
  assert.equal(p.minutes, 4);
  assert.equal(p.seconds, 5);
});

test('exactly at the target the countdown is released', () => {
  const p = Mia.parts(EXPECTED_TARGET);
  assert.equal(p.released, true);
  assert.equal(Mia.label(p), 'SUDAH RILIS');
});

test('after the target the countdown never shows a negative number', () => {
  const p = Mia.parts(EXPECTED_TARGET + 3600 * 1000);
  assert.equal(p.released, true);
  for (const k of ['days', 'hours', 'minutes', 'seconds', 'totalMs']) {
    assert.ok(p[k] >= 0, k + ' must not be negative');
  }
});

test('format renders four zero padded fields', () => {
  const p = Mia.parts(EXPECTED_TARGET - (((1 * 86400) + (2 * 3600) + (3 * 60) + 4)) * 1000);
  assert.equal(Mia.format(p), '01 : 02 : 03 : 04');
  assert.equal(Mia.format(Mia.parts(EXPECTED_TARGET)), '00 : 00 : 00 : 00');
});

test('the seconds field rolls over on its own', () => {
  const p = Mia.parts(EXPECTED_TARGET - 1000);
  assert.equal(p.seconds, 1);
  assert.equal(p.minutes, 0);
  assert.equal(p.days, 0);
});
