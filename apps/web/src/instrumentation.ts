/**
 * Next.js instrumentation (see docs: guides/instrumentation).
 *
 * `register` runs once at server startup in BOTH runtimes (edge + node). The
 * Telegram bot and its node:fs-backed assistant core must only ever run on
 * Node, so we guard on NEXT_RUNTIME and defer the Node-only work to
 * `./instrumentation-node` (loaded only inside the nodejs branch).
 *
 * This starts the always-on Telegram bot as part of the SAME Next process, so
 * the whole personal assistant (web + Telegram) is a single deployable process
 * (PRD v2.0 §11, Fase 2).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
