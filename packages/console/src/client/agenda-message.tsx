/**
 * agenda-message.tsx — an agenda a seat wrote, shown as an agenda.
 *
 * The secretary answers an agenda request with JSON, because the draft card
 * and the confirm button need it. A person reading the discussion is not the
 * draft card: they are deciding whether this is the plan they want, and
 * braces, quotes and `\n` in a 400-character instruction are unreadable at
 * exactly the moment reading matters. So the thread shows the outline, the
 * same way it already shows a team plan, and the bytes stay one click away.
 */
import { MarkdownText } from "@deepseek-ai/dsh-client-ui-primitives";
import type { AgendaInText } from "./agenda-text.ts";
import { MARKDOWN_LABELS } from "./markdown-labels.ts";
import { useT } from "./locale.ts";
import styles from "./panel.module.css";

const EXIT_LABEL = {
  "after-tasks": "agenda.exit.tasks",
  "after-bounded-rounds": "agenda.exit.rounds",
  "wait-for-host": "agenda.exit.host",
} as const;

export function AgendaMessage({
  found,
  seatNames,
}: {
  readonly found: AgendaInText;
  /** seatId → the name people know them by. */
  readonly seatNames: ReadonlyMap<string, string>;
}): JSX.Element {
  const t = useT();
  const { agenda } = found;
  return (
    <div>
      {found.before === "" ? null : <MarkdownText text={found.before} labels={MARKDOWN_LABELS} />}
      {agenda.hostGoal === undefined ? null : (
        <>
          <div className={styles.subhead}>{t("agenda.goal")}</div>
          <div>{agenda.hostGoal}</div>
        </>
      )}
      <div className={styles.subhead}>{t("agenda.phases", { n: agenda.phases.length })}</div>
      <ol className={styles.planList}>
        {agenda.phases.map((phase, index) => (
          <li key={`${phase.id ?? index}`}>
            <strong>{phase.title}</strong>
            {phase.purpose === undefined ? null : <div className={styles.hint}>{phase.purpose}</div>}
            <div className={styles.hint}>
              {[
                phase.needs === undefined
                  ? undefined
                  : phase.needs.length === 0
                    ? t("agenda.needs.none")
                    : t("agenda.needs", { ids: phase.needs.join("、") }),
                phase.exit === undefined
                  ? undefined
                  : `${t(EXIT_LABEL[phase.exit as keyof typeof EXIT_LABEL] ?? "agenda.exit.tasks")}${phase.maxRounds === undefined ? "" : ` × ${phase.maxRounds}`}`,
                phase.contextMode === "independent" ? t("agenda.independent") : undefined,
              ]
                .filter((part): part is string => part !== undefined)
                .join(" · ")}
            </div>
            <ul className={styles.planList}>
              {phase.tasks.map((task, at) => (
                <li key={`${task.seatId}-${at}`}>
                  <strong>{seatNames.get(task.seatId) ?? task.seatId}</strong>
                  <div style={{ whiteSpace: "pre-wrap" }}>{task.instruction}</div>
                  {task.artifactPath === undefined ? null : (
                    <div className={styles.hint}>{t("agenda.file", { path: task.artifactPath })}</div>
                  )}
                </li>
              ))}
            </ul>
            {phase.check === undefined ? (
              <div className={styles.hint}>{t("agenda.check.none")}</div>
            ) : (
              <div className={styles.hint}>
                {t("agenda.check")} <code>{phase.check.command}</code>
              </div>
            )}
          </li>
        ))}
      </ol>
      {found.after === "" ? null : <MarkdownText text={found.after} labels={MARKDOWN_LABELS} />}
      <details>
        <summary className={styles.sectionToggle}>{t("agenda.raw")}</summary>
        <pre className={styles.planRaw}>{found.json}</pre>
      </details>
    </div>
  );
}
