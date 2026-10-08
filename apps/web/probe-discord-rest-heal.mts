/**
 * Durable probe: does discordRestTokenHeal actually REVIVE sending?
 *
 * Run:  npx tsx apps/web/probe-discord-rest-heal.mts
 *
 * Unit tests only assert that we call client.rest.setToken(token). They cannot
 * show that this changes the real failure mode, because the failure mode lives
 * inside discord.js. This probe does, against the real library:
 *
 *   1. login clean          -> a send goes out and Discord answers (token present)
 *   2. login fails once with a 522-shaped error, exactly as Cloudflare produced it
 *      -> discord.js destroy() wipes the REST token, while the WebSocketManager
 *         "reconnects" (stubbed) and reaches Ready
 *      -> a send now dies with the SAME string seen in /tmp/mia-dev.log
 *   3. after the heal       -> the send goes out again
 *
 * Step 1 is the control that makes step 2 meaningful. An earlier draft of this
 * probe tried to read client.rest.token as the signal and got `undefined` in
 * BOTH cases -- that getter does not exist on discord.js 14.27 REST, so it
 * proved nothing. The signal is whether a request leaves the process, which is
 * also what the owner experienced.
 *
 * The token is fake on purpose. Discord answers 401, and a 401 is the proof we
 * want: the request was authenticated far enough to be rejected by the server,
 * i.e. it left the process carrying an Authorization header. No live bot, no
 * real credentials, no gateway connection is ever opened.
 *
 * Exit 0 = PASS. Non-zero = the heal is broken; do not ship it.
 */

import { Client, GatewayIntentBits, Partials } from "discord.js";
import { discordRestTokenHeal } from "./src/lib/discordRestTokenHeal";

const TOKENLESS_ERROR = "Expected token to be set for this request";

let failures = 0;
function check(label: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`  PASS  ${label} -- ${detail}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label} -- ${detail}`);
  }
}

function makeClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message],
  });
}

/** One real send attempt. Never throws: returns the error message instead. */
async function sendAttempt(client: Client): Promise<string> {
  try {
    await (client as unknown as { rest: { post: (r: string, o: unknown) => Promise<unknown> } }).rest.post(
      "/users/@me/guilds",
      { body: {} },
    );
    return "REQUEST_SENT";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function main(): Promise<void> {
  console.log("probe: discord REST token heal (fake token, no gateway, no live bot)\n");

  // --- 1. control: a clean login leaves the REST able to authenticate ---
  const control = makeClient();
  (control as unknown as { ws: { connect: () => Promise<void> } }).ws.connect = async () => {};
  await control.login("FAKE_TOKEN_CONTROL");
  const controlResult = await sendAttempt(control);
  check(
    "control: clean login can send",
    controlResult !== TOKENLESS_ERROR,
    `control send -> ${controlResult}`,
  );

  // --- 2. the production failure: connect throws, manager still reaches Ready ---
  const broken = makeClient();
  let connectCalls = 0;
  (broken as unknown as { ws: { connect: () => Promise<void>; status: number } }).ws.connect = async () => {
    connectCalls += 1;
    if (connectCalls === 1) {
      throw Object.assign(new Error("Unexpected server response: 522"), { code: "ETIMEDOUT" });
    }
    // second call = the WebSocketManager's own reconnect, which reaches Ready
  };
  let loginError = "";
  try {
    await broken.login("FAKE_TOKEN_BROKEN");
  } catch (err) {
    loginError = err instanceof Error ? err.message : String(err);
  }
  check("failure reproduced: login rejects on a 522", loginError.includes("522"), `login -> ${loginError}`);

  const wsStatus = (broken as unknown as { ws: { status: number } }).ws.status;
  const beforeHeal = await sendAttempt(broken);
  check(
    "failure reproduced: send is dead before the heal",
    beforeHeal.includes(TOKENLESS_ERROR),
    `pre-heal send -> ${beforeHeal}`,
  );
  check("gateway is up even while REST is dead", wsStatus === 3, `ws.status=${wsStatus} (3 = Ready)`);

  // --- 3. the heal revives sending ---
  discordRestTokenHeal(broken, "FAKE_TOKEN_BROKEN", "mia", (m) => console.log(`  log: ${m}`));
  const afterHeal = await sendAttempt(broken);
  check(
    "heal revives sending",
    afterHeal !== TOKENLESS_ERROR && afterHeal !== beforeHeal,
    `post-heal send -> ${afterHeal}`,
  );

  console.log("");
  if (failures === 0) {
    console.log("RESULT: PASS -- the heal revives a client that discord.js left half-alive");
    process.exit(0);
  }
  console.log(`RESULT: FAIL -- ${failures} check(s) failed; the heal is not trustworthy`);
  process.exit(1);
}

void main();
