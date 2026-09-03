/**
 * criteria.tsx — Lil X's judgements, and the place a verdict is given.
 *
 * The header used to say 「1 条判据待裁定」 and stop there. A number that names
 * an obligation has to lead somewhere; that one led to a slash command you
 * had to already know about, in a chat that needs a configured model — so on
 * a fresh install the badge was unreachable by construction.
 *
 * Evidence is a COUNT, never the instances. Instances are the user's own
 * occurrences with project detail in them and they never leave the machine;
 * rendering them here would be the first thing to carry one across that line.
 */
import { api, useAction } from "./api.ts";
import type { SquadSnapshot } from "./api.ts";
import { useT } from "./locale.ts";
import styles from "./panel.module.css";

type CriterionView = SquadSnapshot["criteria"]["proposals"][number];

function Trigger({ trigger }: { readonly trigger: CriterionView["trigger"] }): JSX.Element {
  const t = useT();
  const parts = [...trigger.action, ...trigger.features, ...(trigger.step ?? [])];
  return <span className={styles.muted}>{parts.length === 0 ? t("criteria.anywhere") : parts.join(" · ")}</span>;
}

export function CriteriaPage({
  criteria,
  onChanged,
}: {
  readonly criteria: SquadSnapshot["criteria"];
  readonly onChanged: () => void;
}): JSX.Element {
  const t = useT();
  const { error, run } = useAction(onChanged);

  return (
    <div>
      <div className={styles.hint}>{t("criteria.intro")}</div>

      <div className={styles.subhead}>{t("criteria.pending.head", { n: criteria.proposals.length })}</div>
      {criteria.proposals.length === 0 ? (
        <div className={styles.hint}>{t("criteria.pending.none")}</div>
      ) : (
        criteria.proposals.map((criterion) => (
          <div key={criterion.id} className={styles.card}>
            <div className={styles.teamName}>{criterion.claim}</div>
            {criterion.boundary === undefined ? (
              // Said out loud, because a criterion with no boundary is a
              // slogan with no conditions attached — which is how a useful
              // judgement turns into dogma.
              <div className={styles.hint}>{t("criteria.boundary.missing")}</div>
            ) : (
              <div className={styles.muted}>{t("criteria.boundary", { text: criterion.boundary })}</div>
            )}
            <div className={styles.muted}>
              {t("criteria.trigger")}
              <Trigger trigger={criterion.trigger} />
              {t("criteria.evidence", { n: criterion.evidence })}
            </div>
            <div className={styles.row}>
              <button
                type="button"
                className={styles.button}
                onClick={() => void run(() => api.resolveCriterion({ id: criterion.id, verdict: "accept" }))}
              >
                {t("criteria.adopt")}
              </button>
              <button
                type="button"
                className={styles.button}
                onClick={() => void run(() => api.resolveCriterion({ id: criterion.id, verdict: "reject" }))}
              >
                {t("criteria.reject")}
              </button>
            </div>
          </div>
        ))
      )}

      <div className={styles.subhead}>{t("criteria.live.head", { n: criteria.live.length })}</div>
      {criteria.live.length === 0 ? (
        <div className={styles.hint}>{t("criteria.live.none")}</div>
      ) : (
        criteria.live.map((criterion) => (
          <div key={criterion.id} className={styles.card}>
            <div className={styles.row}>
              <span className={styles.teamName}>{criterion.claim}</span>
              {criterion.status === "active" ? null : <span className={styles.badgeBad}>{criterion.status}</span>}
            </div>
            {criterion.boundary === undefined ? null : (
              <div className={styles.muted}>{t("criteria.boundary", { text: criterion.boundary })}</div>
            )}
            <div className={styles.muted}>
              {t("criteria.trigger")}
              <Trigger trigger={criterion.trigger} />
              {t("criteria.evidence", { n: criterion.evidence })}
            </div>
            {criterion.health === undefined ? null : (
              <div className={styles.muted}>
                {criterion.health.verdict}：{criterion.health.detail}
              </div>
            )}
          </div>
        ))
      )}
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
    </div>
  );
}
