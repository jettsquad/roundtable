/**
 * @squad/migrate — the one-time 1.x → 2.0 move.
 *
 * Mounted by hand, run once, never part of a shipped composition. It exists
 * so that switching does not mean abandoning the discussions already had —
 * those are the only thing in 1.x that cannot be rebuilt.
 *
 * One rule decides everything here: a plan with anything unaccounted for is
 * NOT applied. A partial migration produces a team that looks migrated and
 * has a hole in it, and nobody finds the hole, because the only evidence the
 * missing thing existed is the thing that went missing. Refusing costs a
 * person ten minutes; a silent gap costs them the belief that their history
 * is intact.
 *
 * Dry-run first, always: it reports what would move and what it could not
 * read, and touches nothing.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { planMigration, type LegacyTeam, type MigrationPlan } from "./read.ts";

export const name = "squad-migrate";
export const inject = ["teams", "teamContext"];

export interface Config {
  /** 1.x userData root — the directory holding `teams/`. */
  readonly legacyRoot: string;
  /** Report only. Applying requires setting this to false deliberately. */
  readonly dryRun?: boolean;
}

/** Read every 1.x team under `<root>/teams`. */
export function readLegacyTeams(legacyRoot: string): readonly { id: string; team: LegacyTeam }[] {
  const teamsRoot = join(legacyRoot, "teams");
  if (!existsSync(teamsRoot)) return [];
  const found: { id: string; team: LegacyTeam }[] = [];
  for (const entry of readdirSync(teamsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const configPath = join(teamsRoot, entry.name, "team.json");
    if (!existsSync(configPath)) continue;
    const config: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    const logPath = join(teamsRoot, entry.name, "events.log");
    const events = existsSync(logPath)
      ? readFileSync(logPath, "utf8")
          .split("\n")
          .filter((raw) => raw.trim() !== "")
          .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      : [];
    found.push({ id: entry.name, team: { config, events } });
  }
  return found;
}

export function apply(ctx: Context, config: Config): void {
  void (async () => {
    const line = (text: string) => process.stdout.write(`[migrate] ${text}\n`);
    const dryRun = config.dryRun !== false;
    try {
      const legacy = readLegacyTeams(config.legacyRoot);
      line(`在 ${config.legacyRoot} 下找到 ${legacy.length} 支 1.x 团队。${dryRun ? "（试运行，不写任何东西）" : ""}`);

      for (const { id, team } of legacy) {
        const plan = planMigration(team);
        line(
          `[${id}] ${plan.displayName}：${plan.seats.length} 个席位、${plan.lines.length} 条发言、` +
            `${plan.checkpoints.length} 份检查点、${plan.artifacts.length} 个产出`,
        );
        if (plan.unaccounted.length > 0) {
          line(`  ⚠️ 有 ${plan.unaccounted.length} 处读不懂，**不迁移这支团队**：`);
          for (const problem of plan.unaccounted) line(`    - ${problem}`);
          continue;
        }
        if (dryRun) {
          line("  ✓ 可以迁移（试运行，未执行）");
          continue;
        }
        const teamId = await applyPlan(ctx, plan);

        // Read back, rather than reporting success because nothing threw. A
        // migration that says "done" without checking is the same claim the
        // rest of this project refuses to make anywhere else.
        const carried = await ctx.teamContext.windowFor(teamId, plan.seats[0]?.seatId ?? "");
        const window = carried.join("\n");
        const restoredArtifacts = ctx.teamContext.artifactsOf(teamId);
        const lastCheckpoint = plan.checkpoints[plan.checkpoints.length - 1];
        const checkpointCarried = lastCheckpoint === undefined || window.includes(lastCheckpoint.text.slice(0, 12));
        const artifactsCarried = plan.artifacts.every((path) => restoredArtifacts.includes(path));
        line(
          `  ✓ 已迁移为 ${teamId}：窗口 ${carried.length} 行，检查点在=${checkpointCarried}，` +
            `产出 ${restoredArtifacts.length}/${plan.artifacts.length} 条`,
        );
        if (!checkpointCarried || !artifactsCarried) {
          line("  ⚠️ 回读对不上——这支团队迁过去了但内容不完整，请检查");
        }
      }
      line("结束。");
    } catch (error) {
      line(`失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  })();
}

/**
 * Create the 2.0 team and replay its history into it.
 *
 * Speech goes through the same `ask`-free path a live team uses for its
 * record, and checkpoints go to the storage domain — so a migrated team is
 * not a special shape that only the migration knows how to read. If it were,
 * the first thing to break would be everything downstream of it.
 */
export async function applyPlan(ctx: Context, plan: MigrationPlan): Promise<string> {
  const team = await ctx.teams.create({
    displayName: plan.displayName,
    projectFolder: plan.projectFolder,
    hostDisplayName: plan.hostDisplayName,
    seats: plan.seats,
    ...(plan.checkpointCoefficient === undefined ? {} : { checkpointCoefficient: plan.checkpointCoefficient }),
  });

  // Replayed in order, so the 2.0 record reads as the discussion did.
  for (const spoken of plan.lines) {
    team.recordSpoken(spoken.speaker, spoken.text, spoken.turnId);
  }
  for (const checkpoint of plan.checkpoints) {
    await ctx.teamContext.record({
      teamId: team.teamId,
      text: checkpoint.text,
      coversUpTo: checkpoint.coversUpTo,
      ...(checkpoint.revokedAt === undefined ? {} : { revokedAt: checkpoint.revokedAt }),
    });
  }
  // Restored too. The plan collects them and nothing consumed them at first
  // — the plan would have carried a list into the void, and the migrated
  // team's next checkpoint would have indexed nothing while the files sat in
  // the project folder. Wrong in the direction that reads as "there were no
  // outputs".
  for (const path of plan.artifacts) {
    await ctx.teamContext.recordArtifact(team.teamId, path);
  }
  return team.teamId;
}

export { planMigration } from "./read.ts";
export type { LegacyTeam, MigrationPlan, PlannedCheckpoint, PlannedLine } from "./read.ts";
