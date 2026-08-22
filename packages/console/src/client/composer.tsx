/**
 * composer.tsx — the box at the bottom, sending to the team.
 *
 * There were two input boxes on one screen and no way to tell which was
 * which. The one at the bottom is dsh's, and it answers to dsh's own chat
 * agent — a model with its own API key that has nothing to do with the team.
 * So a person in a team session typed into the obvious box and nothing
 * happened, which is exactly what was reported.
 *
 * `conversation.composer` is a chain slot whose fallback is the ordinary
 * input bar, kept mounted under an election so its draft survives. Electing
 * on a team's session puts this in its place: same position, same habit, and
 * it goes to the team.
 */
import { useEffect, useState } from "react";
// dsh's own primitives, which ARE shared: `Button` and `Input` are exported
// from the platform module table. Its INPUT BAR is not — that component is
// internal to ui-conversation and wired to dsh's own send path — so the box
// below takes the bar's PLACE through the composer chain and is built from
// the same pieces the rest of the app is.
import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import { api, useSnapshot } from "./api.ts";
import { parseMentions } from "../mention.ts";
import styles from "./panel.module.css";

interface SquadComposerProps {
  /**
   * The workspace folder this session sits in.
   *
   * The election already decided this folder has a team; the team itself is
   * read here so its roster and running state stay live while the round goes,
   * rather than being frozen at election time.
   */
  readonly folder: string;
}

export function SquadComposer({ folder }: SquadComposerProps): JSX.Element {
  const [nonce, setNonce] = useState(0);
  const snapshot = useSnapshot(nonce);
  const onSent = (): void => setNonce((value) => value + 1);
  const current = snapshot.state === "ready" ? snapshot.data.teams.find((t) => t.projectFolder === folder) : undefined;
  const [instruction, setInstruction] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (current === undefined) {
    return (
      <div className={styles.composerBox}>
        <span className={styles.muted}>
          {snapshot.state === "loading" ? "读取团队中……" : `${folder} 的团队已经不在了。`}
        </span>
      </div>
    );
  }

  // Who this sentence is addressed to, read out of the sentence itself.
  const mentions = parseMentions(
    instruction,
    current.seats.map((seat) => seat.displayName),
  );
  const named = current.seats.filter((seat) => mentions.named.includes(seat.displayName));
  const asked = named.length === 0 ? current.seats : named;
  const blocked = asked.filter((seat) => seat.blocked !== undefined);
  const allBlocked = asked.length > 0 && blocked.length === asked.length;
  // A misspelled name is refused rather than quietly widened to everyone:
  // the box would read as though it were aimed at one person while the
  // question went to the whole team.
  const misnamed = mentions.unknown.length > 0;

  const send = async (): Promise<void> => {
    setError(undefined);
    setRunning(true);
    // Text left sitting in the box after it was sent is text you send again,
    // which is how one question became four identical ones in the record.
    const sent = mentions.instruction;
    const seatIds = named.map((seat) => seat.seatId);
    setInstruction("");
    try {
      await api.say({
        teamId: current.teamId,
        // The roll-call is stripped: a seat that also found 「@架构」 inside
        // its own task would be reading an address as an instruction.
        instruction: sent,
        ...(seatIds.length === 0 ? {} : { seatIds }),
      });
      // The answers land in the discussion, which is the ONE place a
      // conversation is shown. Repeating them here is what put the same
      // sentences on the screen twice.
      onSent();
    } catch (failure) {
      // Put the text back when it did not go out, so a refusal does not also
      // cost the sentence.
      setInstruction(sent);
      setError(String((failure as Error).message ?? failure));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={styles.composerBox}>
      <div className={styles.composerWho}>
        发给团队「{current.displayName}」{current.seats.length === 0 ? " · 还没有成员" : ""}
      </div>

      <div className={styles.row}>
        <Input
          className={styles.grow ?? ""}
          value={instruction}
          placeholder={`跟「${current.displayName}」说点什么，@ 点名单独问某人…`}
          disabled={running}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !running && instruction.trim() !== "") void send();
          }}
        />
        <Button
          type="button"
          variant="primary"
          disabled={
            running || mentions.instruction.trim() === "" || current.seats.length === 0 || allBlocked || misnamed
          }
          onClick={() => void send()}
        >
          {running
            ? `进行中 ${elapsed}s`
            : named.length === 0
              ? "问所有人"
              : `问 ${named.map((seat) => seat.displayName).join("、")}`}
        </Button>
        {!current.busy ? null : (
          <Button
            type="button"
            onClick={() =>
              // The refusal is shown. It used to be dropped on the floor,
              // which is what made the button look dead.
              void api
                .stop({ teamId: current.teamId })
                .then(onSent)
                .catch((failure: Error) => setError(String(failure.message)))
            }
          >
            叫停
          </Button>
        )}
      </div>

      <div className={styles.row}>
        <span className={styles.hint}>
          成员：{current.seats.map((seat) => seat.displayName).join("、") || "（还没有）"}
          {named.length === 0 ? " · 不点名就是问所有人" : ""}
        </span>
      </div>

      {!misnamed ? null : (
        <div className={styles.error}>
          没有叫「{mentions.unknown.join("、")}」的成员。名字打错的话这句话会发给全团，所以先改过来。
        </div>
      )}

      {/* Said while it is still happening. A seat working and a seat hung on
          an endpoint that will never answer look identical from here. */}
      {!running || elapsed < 45 ? null : (
        <div className={styles.hint}>
          已经等了 {elapsed} 秒还没有回复。多半是这个席位的接口地址连不上——到 Agent 库点「测试」看那一项。
        </div>
      )}
      {blocked.length === 0 ? null : (
        <div className={styles.error}>
          {allBlocked ? "这一轮问不出去：" : "这几位跑不了，会被跳过："}
          {blocked.map((seat) => `${seat.displayName}（${seat.blocked}）`).join("、")}
        </div>
      )}
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
    </div>
  );
}
