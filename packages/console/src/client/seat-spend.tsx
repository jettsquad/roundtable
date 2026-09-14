/**
 * seat-spend.tsx — what each seat has spent, wherever a team is shown.
 *
 * Its own file because there are TWO screens showing a team — the panel's
 * card and the session's 团队 tab — and the first version of this landed on
 * only one of them. The person looking at the session tab saw the new columns
 * (those are pure formatting of fields that already travelled) and no per-seat
 * breakdown at all, which reads as 「这个功能没做」 rather than 「加错地方了」.
 *
 * That is the same duplication that had `usageLine` written twice and drifting.
 * One component, imported by both.
 */
import type { TeamSummary } from "./api.ts";
import { useT } from "./locale.ts";
import styles from "./panel.module.css";
import { usageParts } from "./usage-figures.ts";

/**
 * What each seat has spent, and how many reported nothing.
 *
 * The unmeasured COUNT is printed rather than left implicit. A backend with no
 * accounting makes the team total quietly short, and a total that is short
 * without saying so is worse than one that is missing: it gets believed.
 */
export function SeatSpend({ team }: { readonly team: TeamSummary }): JSX.Element | null {
  const t = useT();
  const measured = team.seats.filter((seat) => seat.usage !== undefined && seat.usage.turns > 0);
  if (measured.length === 0) return null;
  const silent = team.seats.length - measured.length;
  return (
    <div className={styles.hint}>
      <div>{t("team.usage.perSeat")}</div>
      {measured.map((seat) => (
        <div key={seat.seatId}>
          {t("team.usage.seat", {
            name: seat.displayName,
            parts: (usageParts(t as never, seat.usage) ?? []).join(" · "),
          })}
        </div>
      ))}
      {silent === 0 ? null : <div>{t("team.usage.unmeasured", { n: silent })}</div>}
    </div>
  );
}
