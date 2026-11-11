/* Human activity phrases for the office dashboard.
 *
 * A tool identifier (google_news, file_read, remind_me …) is developer
 * metadata: it must never be the status line under an agent's name
 * (DESIGN.md §11 — "translate internal values before showing them").
 * This module is the ONE owner of the tool -> human sentence mapping, so the
 * server payload, the floating nameplate and the activity view can never
 * disagree with each other.
 *
 * The raw tool name and its argument stay available in the agent panel
 * Diagnostics (DESIGN.md §12) — nothing is lost, it is only moved out of the
 * primary status line.
 */
'use strict';

/* Exact names first: the tools that actually run in this deployment. */
var EXACT = {
  exec: 'menjalankan perintah',
  file_read: 'membaca berkas',
  file_write: 'menulis kode',
  write_file: 'menulis kode',
  edit_file: 'menulis kode',
  calculate: 'menghitung',
  save_note: 'memperbarui memori',
  delete_note: 'memperbarui memori',
  list_notes: 'memperbarui memori',
  memory_get: 'membaca memori',
  search_memory: 'melakukan riset',
  persona_set: 'memperbarui memori',
  mood_log: 'memperbarui memori',
  remind_me: 'mengatur pengingat',
  reminders_list: 'memeriksa pengingat',
  add_task: 'mengelola tugas',
  complete_task: 'mengelola tugas',
  delete_task: 'mengelola tugas',
  list_tasks: 'mengelola tugas',
  google_news: 'melakukan riset',
  web_search: 'melakukan riset',
  gmail_list: 'membaca email',
  gmail_read: 'membaca email',
  gmail_search: 'melakukan riset',
  finding_add: 'memeriksa keamanan',
  finding_list: 'memeriksa keamanan',
  finding_resolve: 'memeriksa keamanan',
  report_generate: 'memeriksa keamanan',
  report_save: 'memeriksa keamanan',
  report_pdf: 'memeriksa keamanan',
  coverage: 'memeriksa keamanan',
  threat_model: 'memeriksa keamanan',
  exposure_hunt: 'memeriksa keamanan',
  mass_assignment: 'menjalankan pengujian',
  web_audit: 'memeriksa keamanan',
  lab_add: 'menyiapkan pengujian',
  library_list: 'mengelola pustaka',
  library_remove: 'mengelola pustaka',
  spotify_play: 'memutar musik',
  spotify_pause: 'memutar musik',
  spotify_next: 'memutar musik',
  spotify_previous: 'memutar musik',
  spotify_search: 'mencari lagu',
  spotify_status: 'memutar musik',
  spotify_mode: 'memutar musik',
  spotify_queue: 'memutar musik',
  spotify_devices: 'memutar musik',
  weather: 'memeriksa cuaca',
  cinema_showtimes: 'mencari tontonan',
  places_search: 'mencari tempat'
};

/* Families cover every other tool the registry can emit. The order matters:
   the first matching family wins, so the specific ones come first. */
var FAMILIES = [
  [/pentest|exploit|proof|vuln|cve|cwe|recon|osint/i, 'memeriksa keamanan'],
  [/test|verify|poc|probe|scan|fuzz|validate|audit|hunt|prove/i, 'menjalankan pengujian'],
  [/code|patch|commit|repo|build|lint/i, 'menulis kode'],
  [/file|note|write|edit|upload|download/i, 'menulis kode'],
  [/exec|shell|bash|npm|run|cmd|deploy/i, 'menjalankan perintah'],
  [/research|web|browse|fetch|crawl|search|news|read/i, 'melakukan riset'],
  [/gmail|mail|inbox/i, 'membaca email'],
  [/spotify|music|song|playlist/i, 'memutar musik'],
  [/remind|alarm|schedule/i, 'mengatur pengingat'],
  [/task|todo|queue|dispatch/i, 'mengelola tugas'],
  [/persona|memory|mood|learn|clawic/i, 'memperbarui memori'],
  [/calculate|math|compute/i, 'menghitung'],
  [/weather|cuaca/i, 'memeriksa cuaca'],
  [/hotel|train|bus|flight|cinema|place|travel/i, 'mencari informasi']
];

var DEFAULT_PHRASE = 'bekerja';

/* "tool:google_news" -> "google_news"; "turn_provider" -> "turn_provider". */
function toolName(action) {
  var s = String(action == null ? '' : action).trim();
  return s.indexOf('tool:') === 0 ? s.slice(5) : s;
}

/* The human phrase for an action. Non-tool actions return '' so the caller
   keeps its own wording for them. */
function humanActivity(action) {
  var raw = toolName(action);
  if (!raw) return '';
  if (String(action).indexOf('tool:') !== 0) return '';
  var name = raw.split('::')[0].trim();
  if (!name) return '';
  if (Object.prototype.hasOwnProperty.call(EXACT, name)) return EXACT[name];
  for (var i = 0; i < FAMILIES.length; i++) {
    if (FAMILIES[i][0].test(name)) return FAMILIES[i][1];
  }
  return DEFAULT_PHRASE;
}

module.exports = { toolName: toolName, humanActivity: humanActivity, EXACT: EXACT, FAMILIES: FAMILIES };
