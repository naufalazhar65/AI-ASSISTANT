// Proof: the exact runtime path that failed at 10:43 (finding_list →
// autoApproveAllowed → dynamic import of policy.ts) now resolves, and the
// honesty guard fires on the live ask shape. No LLM call, no network.
import { endpointTriageNote, userAskedForList } from "./src/lib/agent";
import { executeTool } from "./src/lib/tools";
import { autoApproveAllowed, readPolicy } from "./src/lib/policy";

const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
const ask = `mia coba lakukan full pentest secara menyeluruh di ${LAB}/cek-nik dan buatkan report pdfnya`;
const reply =
  "Mas Naufal, pengujian menyeluruh pada portal tersebut sudah selesai dan laporan PDF-nya berhasil dibuat di: report-2026-09-25T03-32-12-369Z.pdf 🌸";
const user = `verify_chunk_${Date.now()}`;

let fail = 0;
const ok = (c: boolean, label: string, detail = "") => {
  console.log(`${c ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!c) fail++;
};

// 1. the module that could not be found at 10:43
const policy = readPolicy();
ok(policy !== null, "policy.ts loads (the chunk missing at 10:43)", `autoApprove: ${policy.autoApprove?.length ?? 0} tools`);
const approval = autoApproveAllowed("http_request", "write", { url: `${LAB}/cek-nik` }, { urlAllowed: () => true });
ok(typeof approval === "boolean", "autoApproveAllowed() executes (no module error)", `→ ${approval}`);

// 2. finding_list — the call that ran before the crash
const fl = await executeTool(
  { id: "x", name: "finding_list", arguments: JSON.stringify({ target: `${LAB}/cek-nik` }) },
  user
);
ok(!String(fl).startsWith("Error:"), "finding_list executes on the live target", String(fl).replace(/\s+/g, " ").slice(0, 60));

// 3. the honesty guard on the same message shape
const msgs = [
  { role: "user", content: ask },
  { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "finding_list", arguments: `{"target":"${LAB}/cek-nik"}` } }] },
  { role: "tool", tool_call_id: "a", content: String(fl) },
  { role: "assistant", content: reply },
] as unknown as Parameters<typeof endpointTriageNote>[0];
ok(userAskedForList("finding_list", ask) === false, "no verbatim hijack");
ok(/tidak menyentuh/i.test(endpointTriageNote(msgs, reply)), "honesty note fires (zero-contact, no probe ran)");

console.log(fail === 0 ? "\nRUNTIME PATH OK — 10:43 crash gone, guard armed" : `\nFAIL: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
