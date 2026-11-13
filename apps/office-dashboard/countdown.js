/* Countdown maths for the GTA VI release billboard.
   Classic script (no ESM) so the dashboard's inline IIFE and the node test
   can both use it: the browser gets globalThis.MiaCountdown, node gets
   module.exports. */
(function (root) {
  'use strict';

  /* Explicit +07:00 offset — the release moment is stated in WIB, so it must
     not depend on whatever timezone the server happens to run in. */
  var TARGET_ISO = '2026-11-19T00:00:00+07:00';
  var TARGET_MS = Date.parse(TARGET_ISO);

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /* Remaining time until the target. Never negative: once the target passed
     the countdown reads as released instead of counting backwards. */
  function parts(nowMs) {
    var now = typeof nowMs === 'number' ? nowMs : Date.now();
    var left = TARGET_MS - now;
    if (left <= 0) {
      return { days: 0, hours: 0, minutes: 0, seconds: 0, released: true, totalMs: 0 };
    }
    var secs = Math.floor(left / 1000);
    return {
      days: Math.floor(secs / 86400),
      hours: Math.floor((secs % 86400) / 3600),
      minutes: Math.floor((secs % 3600) / 60),
      seconds: secs % 60,
      released: false,
      totalMs: left
    };
  }

  function format(p) {
    if (!p) return '-- : -- : -- : --';
    if (p.released) return '00 : 00 : 00 : 00';
    return pad2(p.days) + ' : ' + pad2(p.hours) + ' : ' + pad2(p.minutes) + ' : ' + pad2(p.seconds);
  }

  function label(p) {
    return p && p.released ? 'SUDAH RILIS' : 'RILIS DALAM';
  }

  var api = {
    TARGET_ISO: TARGET_ISO,
    TARGET_MS: TARGET_MS,
    targetMs: function () { return TARGET_MS; },
    parts: parts,
    format: format,
    label: label,
    pad2: pad2
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaCountdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
