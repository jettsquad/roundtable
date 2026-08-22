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
import styles from "./panel.module.css";

type CriterionView = SquadSnapshot["criteria"]["proposals"][number];

function Trigger({ trigger }: { readonly trigger: CriterionView["trigger"] }): JSX.Element {
  const parts = [...trigger.action, ...trigger.features, ...(trigger.step ?? [])];
  return <span className={styles.muted}>{parts.length === 0 ? "任何场合" : parts.join(" · ")}</span>;
}

export function CriteriaPage({
  criteria,
  onChanged,
}: {
  readonly criteria: SquadSnapshot["criteria"];
  readonly onChanged: () => void;
}): JSX.Element {
  const { error, run } = useAction(onChanged);

  return (
    <div>
      <div className={styles.hint}>
        判据是从你的裁定里蒸馏出来的判断——一句主张，加上它在哪里不成立。
        待裁定的那些是机器提出的，采纳之前不会影响任何人。
      </div>

      <div className={styles.subhead}>待裁定（{criteria.proposals.length}）</div>
      {criteria.proposals.length === 0 ? (
        <div className={styles.hint}>没有待裁定的。</div>
      ) : (
        criteria.proposals.map((criterion) => (
          <div key={criterion.id} className={styles.card}>
            <div className={styles.teamName}>{criterion.claim}</div>
            {criterion.boundary === undefined ? (
              // Said out loud, because a criterion with no boundary is a
              // slogan with no conditions attached — which is how a useful
              // judgement turns into dogma.
              <div className={styles.hint}>还没有写「在哪里不成立」。</div>
            ) : (
              <div className={styles.muted}>不适用于：{criterion.boundary}</div>
            )}
            <div className={styles.muted}>
              触发：
              <Trigger trigger={criterion.trigger} /> · {criterion.evidence} 条证据
            </div>
            <div className={styles.row}>
              <button
                type="button"
                className={styles.button}
                onClick={() => void run(() => api.resolveCriterion({ id: criterion.id, verdict: "accept" }))}
              >
                采纳
              </button>
              <button
                type="button"
                className={styles.button}
                onClick={() => void run(() => api.resolveCriterion({ id: criterion.id, verdict: "reject" }))}
              >
                否掉
              </button>
            </div>
          </div>
        ))
      )}

      <div className={styles.subhead}>已生效（{criteria.live.length}）</div>
      {criteria.live.length === 0 ? (
        <div className={styles.hint}>还没有生效的判据。</div>
      ) : (
        criteria.live.map((criterion) => (
          <div key={criterion.id} className={styles.card}>
            <div className={styles.row}>
              <span className={styles.teamName}>{criterion.claim}</span>
              {criterion.status === "active" ? null : <span className={styles.badgeBad}>{criterion.status}</span>}
            </div>
            {criterion.boundary === undefined ? null : (
              <div className={styles.muted}>不适用于：{criterion.boundary}</div>
            )}
            <div className={styles.muted}>
              触发：
              <Trigger trigger={criterion.trigger} /> · {criterion.evidence} 条证据
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
