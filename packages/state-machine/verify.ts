import { ConversationStateMachine, Event, State } from "./src/index";

const LEGAL: [Event, State][] = [
  ["START", "IDLE"],
  ["SPEECH_ENDED", "LISTENING"],
  ["RESPONSE_READY", "PROCESSING"],
  ["TURN_END", "SPEAKING"],
  ["INTERRUPT", "SPEAKING"],
  ["RESUME", "INTERRUPTED"],
  ["SPEECH_STARTED", "LISTENING"],
  ["SPEECH_STARTED", "SPEAKING"],
];

const ILLEGAL: [Event, State][] = [
  ["SPEECH_ENDED", "IDLE"],
  ["RESPONSE_READY", "IDLE"],
  ["SPEECH_ENDED", "SPEAKING"],
  ["RESUME", "IDLE"],
  ["RESPONSE_READY", "LISTENING"],
  ["START", "LISTENING"],
  ["SPEECH_ENDED", "PROCESSING"],
  ["RESUME", "LISTENING"],
  ["TURN_END", "IDLE"],
  ["TURN_END", "PROCESSING"],
];

let failures = 0;

for (const [event, from] of LEGAL) {
  const sm = new ConversationStateMachine(from);
  const next = sm.transition(event);
  if (next === null) {
    console.log(`FAIL legal ${from} +${event} -> expected != null`);
    failures++;
  }
}

for (const [event, from] of ILLEGAL) {
  const sm = new ConversationStateMachine(from);
  const next = sm.transition(event);
  if (next !== null) {
    console.log(`FAIL illegal ${from} +${event} -> expected null, got ${next}`);
    failures++;
  }
}

// Full round-trip must be possible: listen -> process -> speak -> listen.
const roundTrip = new ConversationStateMachine("IDLE");
for (const [event] of [
  ["START"],
  ["SPEECH_ENDED"],
  ["RESPONSE_READY"],
  ["TURN_END"],
] as [Event][]) {
  const next = roundTrip.transition(event);
  if (next === null) failures++;
}
if (roundTrip.current !== "LISTENING") failures++;

// Full interrupt cycle must be possible.
const cycle = new ConversationStateMachine("IDLE");
cycle.transition("START");
cycle.transition("SPEECH_ENDED");
cycle.transition("RESPONSE_READY");
cycle.transition("INTERRUPT");
cycle.transition("RESUME");
if (cycle.current !== "LISTENING") failures++;

console.log(failures === 0 ? "state-machine: OK" : `state-machine: ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);