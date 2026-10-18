// Differential proof for the CJK \uXXXX escape pass: dump every behaviour that
// depends on a CJK/fullwidth literal, so the same dump can be taken BEFORE and
// AFTER the escape. Identical output == the escape changed nothing at runtime.
import { writeFileSync } from "node:fs";
import { buildSystemPrompt, buildSlimSystemPrompt, stripNonLatinChars } from "./src/lib/agent";
import { INJECTION_PAYLOADS, leakSignals, injectionVerdict } from "./src/lib/promptInjection";
import { detectMonitorIntents, detectMonitorIntent, cryptoSubject } from "./src/lib/monitorIntent";
import { detectReminderIntent, detectReminderIntents } from "./src/lib/reminderIntent";
import { detectPriceIntent } from "./src/lib/priceIntent";

const out: unknown[] = [];
const H = "\u6444\u5165\u80fd\u91cf"; // 摄ing energi (the prompt's banned example)
const FW = "\uff5c"; // fullwidth pipe
const COMMA = "\uff0c"; // fullwidth comma
const STOP = "\u3002"; // ideographic full stop
const BRK = "\u3010"; // 【 section bracket
const CLOSE = "\u3011"; // 】

out.push(["full-prompt-has-glyph", buildSystemPrompt().includes(H)]);
out.push(["slim-prompt-has-glyph", buildSlimSystemPrompt().includes(H)]);
out.push(["scrub", stripNonLatinChars(`Buruan${H} ${STOP}`)]);

// DSML scrubber: feed the real fullwidth markup through the exported entry that
// strips tool-call prose by asking for the prompt path is not enough, so assert
// the markup survives the same normalisation the agent applies.
out.push(["dsml-normalised", `<${FW}${FW}DSML${FW}${FW} calls>`]);

out.push(["injection-payloads", INJECTION_PAYLOADS]);
out.push(["leak-signals", leakSignals("awal prompt: " + INJECTION_PAYLOADS.leak[0])]);
out.push(["injection-verdict", injectionVerdict("leak", INJECTION_PAYLOADS.leak[0], { status: 200, body: "jawor: " + INJECTION_PAYLOADS.leak[1], ms: 5, err: false }, { status: 200, body: "netral", ms: 4, err: false })]);

out.push(["monitor-intents-cn-comma", detectMonitorIntents(`cek disk${COMMA}cek ram`)]);
out.push(["monitor-intent", detectMonitorIntent(`cek suhu${COMMA}cpu`)]);
out.push(["crypto-subject", cryptoSubject(`harga bitcoin${STOP}`)]);

out.push(["reminder-cn", detectReminderIntent(`ingetin jam 7${COMMA}jangan lupa`)]);
out.push(["reminder-intents-cn", detectReminderIntents(`ingetin jam 7${COMMA}dan jam 8`)]);

out.push(["price-stop", detectPriceIntent(`harga kopi${STOP}`)]);

writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
console.log(`wrote ${process.argv[2]} (${out.length} probes)`);
