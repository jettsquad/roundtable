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
 */
export * from "./team-checkpoint-threshold.ts";
export * from "./team-artifact.ts";
export * from "./agent-reply-text.ts";
export * from "./agenda.ts";
