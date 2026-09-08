interface MiaStateCarrier {
  __miaState?: string;
  __miaText?: string;
  __miaListeners?: Set<(state: string, text?: string) => void>;
}

function carrier(): MiaStateCarrier {
  return globalThis as unknown as MiaStateCarrier;
}

function getSet(): Set<(state: string, text?: string) => void> {
  if (!carrier().__miaListeners) carrier().__miaListeners = new Set();
  return carrier().__miaListeners!;
}

export function broadcastMiaState(state: string, text?: string) {
  carrier().__miaState = state;
  if (text) carrier().__miaText = text;
  for (const fn of getSet()) fn(state, text);
}

export function getMiaState() {
  return carrier().__miaState ?? "IDLE";
}

export function getMiaText() {
  return carrier().__miaText ?? "";
}

export function subscribeMiaState(fn: (state: string, text?: string) => void) {
  const set = getSet();
  set.add(fn);
  return () => set.delete(fn);
}
