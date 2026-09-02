export const STATES = [
  "IDLE",
  "LISTENING",
  "PROCESSING",
  "SPEAKING",
  "INTERRUPTED",
  "ERROR",
  "RECONNECTING",
] as const;

export type State = (typeof STATES)[number];

export type Event =
  | "START"
  | "SPEECH_STARTED"
  | "SPEECH_ENDED"
  | "RESPONSE_READY"
  | "TURN_END"
  | "INTERRUPT"
  | "RESUME"
  | "RECONNECT"
  | "CONNECTED"
  | "ERROR"
  | "RESET";

type Transition = {
  from: readonly State[];
  to: State;
};

const TRANSITIONS: Record<Event, Transition> = {
  // IDLE -> LISTENING (user starts a session)
  START: { from: ["IDLE", "ERROR"], to: "LISTENING" },

  // Listening continues while speeech is detected
  SPEECH_STARTED: { from: ["LISTENING", "SPEAKING", "INTERRUPTED"], to: "LISTENING" },

  // User finished speaking -> process the transcript
  SPEECH_ENDED: { from: ["LISTENING"], to: "PROCESSING" },

  // AI response (text/audio) is ready to play -> speak
  RESPONSE_READY: { from: ["PROCESSING"], to: "SPEAKING" },

  // AI finished talking -> back to listening for the next turn
  TURN_END: { from: ["SPEAKING"], to: "LISTENING" },

  // User barges in while AI is speaking -> interrupt
  INTERRUPT: { from: ["SPEAKING", "PROCESSING"], to: "INTERRUPTED" },

  // After an interrupt, go back to listening for the new input
  RESUME: { from: ["INTERRUPTED"], to: "LISTENING" },

  // Lost connection -> attempt to rebuild
  RECONNECT: { from: ["SPEAKING", "LISTENING", "PROCESSING"], to: "RECONNECTING" },

  // Connection re-established
  CONNECTED: { from: ["RECONNECTING"], to: "IDLE" },

  // Anywhere -> ERROR
  ERROR: { from: STATES, to: "ERROR" },

  // Anywhere -> IDLE
  RESET: { from: STATES, to: "IDLE" },
};

/**
 * Explicit conversation state machine (PRD §10).
 *
 * Invalid transitions are impossible: `transition` returns `null` (and emits
 * nothing) when the event is not allowed from the current state. This keeps
 * SPEAKING -> PROCESSING, IDLE -> SPEAKING, etc. from ever occurring.
 */
export class ConversationStateMachine {
  private state: State;

  constructor(initial: State = "IDLE") {
    this.state = initial;
  }

  get current(): State {
    return this.state;
  }

  can(event: Event): boolean {
    const t = TRANSITIONS[event];
    return t.from.includes(this.state);
  }

  transition(event: Event): State | null {
    const t = TRANSITIONS[event];
    if (!t.from.includes(this.state)) {
      return null;
    }
    this.state = t.to;
    return this.state;
  }
}
