/**
 * @squad/shared — the pure logic Squad 1.x proved, carried over unchanged.
 *
 * These modules decide what an agent is shown, when a discussion is folded,
 * where a reply is written, and what counts as an answer rather than the
 * model thinking aloud. They were the hardest part of 1.x to get right and
 * they are the only part of it that survives the re-architecture, so they
 * arrive here with their tests: the tests are the acceptance criteria for
 * the move.
 *
 * Nothing here may import a plugin or a framework. Anything that needs a
 * service belongs in the plugin that owns that service.
 *
 * `package.json` declares `"sideEffects": false`, and that declaration is
 * load-bearing rather than decorative: the browser bundle imports one
 * function from here, and without it the whole barrel comes along —
 * `agenda.ts` pulls zod, and the panel's bundle went from 12 KB to 333 KB.
 * The claim is true by construction (this package is pure functions, which
 * the lint wall enforces), so anything added here that runs at import time
 * breaks it silently.
 */
export * from "./team-checkpoint-threshold.ts";
export * from "./team-artifact.ts";
export * from "./agent-reply-text.ts";
export * from "./agenda.ts";
export * from "./situation.ts";
export * from "./seat-provider.ts";
export * from "./seat-usage.ts";
export * from "./connection.ts";
export * from "./agent-template.ts";
export * from "./agent-check.ts";
export * from "./material.ts";
export * from "./agenda-identity.ts";
export * from "./team-plan.ts";
export * from "./model-json.ts";
export * from "./prompt-blocks.ts";
export * from "./speakable.ts";
export * from "./voices.ts";
