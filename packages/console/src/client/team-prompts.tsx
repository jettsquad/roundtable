/**
 * team-prompts.tsx — which shared blocks this team uses, and who reads them.
 *
 * The middle tier's editing surface. Two things live here and they are not
 * the same thing: the blocks EVERY seat reads, and the named sets that give
 * some blocks to some seats. Sets rather than a seat×block grid because
 * membership overlaps in practice — the seats that produce share a method,
 * the seats that publish share a rule, one seat does both — and a named set
 * says WHY those seats are grouped, which a grid of checkboxes never can.
 *
 * The whole shape is saved in one call. A screen where the blocks, the
 * selection and the sets are edited together must not be able to half-apply:
 * two of the three describing a state the third never agreed to is a team
 * running instructions nobody wrote.
 */
import { useEffect, useState } from "react";
import { blocksForSeat, checkPromptSet, type PromptBlock, type PromptSet, type TeamPrompts } from "@squad/shared";
import { api, type TeamSummary } from "./api.ts";
import styles from "./panel.module.css";

/** A chip that can be opened and taken off. */
function Chip({
  label,
  tone,
  onOpen,
  onRemove,
}: {
  label: string;
  tone?: "accent" | "warn";
  onOpen?: () => void;
  onRemove?: () => void;
}): JSX.Element {
  return (
    <span
      className={`${styles.chip} ${tone === "warn" ? styles.chipWarn : tone === "accent" ? styles.chipAccent : ""}`}
    >
      {onOpen === undefined ? (
        label
      ) : (
        <button type="button" className={styles.chipOpen} onClick={onOpen} title="看这一段正文，或改本队这一份">
          {label}
        </button>
      )}
      {onRemove === undefined ? null : (
        <button type="button" className={styles.chipX} onClick={onRemove} aria-label={`移除 ${label}`}>
          ×
        </button>
      )}
    </span>
  );
}

/**
 * Editing one block, in one team.
 *
 * Three actions, because there are genuinely three different things a person
 * means here, and collapsing them is what makes 「我改了怎么没生效」 and
 * 「我只想改这一队怎么全变了」 both possible at once:
 *
 *   保存到本队   this team, from the next round
 *   同时写回库   and every team built after this one
 *   用库版本     throw away what this team changed
 *
 * The library copy is named as the thing being diverged from, and the
 * write-back says who it reaches, because those two questions pull in
 * opposite directions and only the screen can settle them.
 */
function BlockEditor({
  copy,
  library,
  edited,
  busy,
  onSave,
  onClose,
}: {
  readonly copy: PromptBlock;
  readonly library: PromptBlock | undefined;
  readonly edited: boolean;
  readonly busy: boolean;
  readonly onSave: (next: PromptBlock, alsoLibrary: boolean) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const [text, setText] = useState(copy.text);
  const dirty = text !== copy.text;
  return (
    <div className={styles.calloutSection}>
      <div className={styles.row}>
        <span className={styles.teamName}>{copy.name}</span>
        {edited ? (
          <span className={styles.muted}>本队这一份和库里不一样</span>
        ) : library === undefined ? (
          <span className={styles.muted}>库里已经没有这一段了</span>
        ) : (
          <span className={styles.muted}>和库里一致</span>
        )}
        <button type="button" className={styles.button} onClick={onClose}>
          收起
        </button>
      </div>
      <textarea className={styles.textarea} rows={10} value={text} onChange={(event) => setText(event.target.value)} />
      <div className={styles.row}>
        <button
          type="button"
          className={styles.button}
          disabled={busy || !dirty}
          onClick={() => onSave({ ...copy, text }, false)}
        >
          保存到本队
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={busy || (!dirty && !edited)}
          onClick={() => onSave({ ...copy, text }, true)}
        >
          同时写回库
        </button>
        {library === undefined || (!edited && !dirty) ? null : (
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            onClick={() => {
              // Asked, because it is the one button here that destroys
              // something somebody wrote on purpose.
              if (window.confirm(`用库里的版本覆盖本队这一份？本队对「${copy.name}」的修改会没有。`)) {
                setText(library.text);
                onSave({ ...copy, name: library.name, text: library.text }, false);
              }
            }}
          >
            放弃修改，用库版本
          </button>
        )}
      </div>
      <div className={styles.hint}>
        保存到本队：下一轮生效，只影响这支团队。写回库：还会影响之后<strong>新建</strong>
        的团队；已经建好的别的团队不受影响。
      </div>
    </div>
  );
}

export function TeamPromptsPanel({
  team,
  library,
  onChanged,
}: {
  readonly team: TeamSummary;
  readonly library: readonly PromptBlock[];
  readonly onChanged: () => void;
}): JSX.Element {
  const prompts = team.prompts;
  const edited = new Set(team.editedBlockIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState(team.seats[0]?.seatId ?? "");
  const [editing, setEditing] = useState<string | undefined>(undefined);

  const open = prompts.blocks.find((block) => block.blockId === editing);

  const nameOf = (blockId: string): string =>
    prompts.blocks.find((block) => block.blockId === blockId)?.name ?? `已删除的片段（${blockId}）`;

  const push = (next: TeamPrompts): void => {
    setBusy(true);
    setError(undefined);
    void api
      .setTeamPrompts({ teamId: team.teamId, prompts: next })
      .then(onChanged)
      .catch((problem: Error) => setError(problem.message))
      .finally(() => setBusy(false));
  };

  /**
   * Copy a library entry into this team, then place it.
   *
   * The callback is `place`, not `use`: React 19 has a `use()` hook, and a
   * bare `use(...)` call reads as one — to the linter, and to a person.
   */
  const adopt = (blockId: string, place: (prompts: TeamPrompts, blockId: string) => TeamPrompts): void => {
    const entry = library.find((block) => block.blockId === blockId);
    if (entry === undefined) return;
    const held = prompts.blocks.some((block) => block.blockId === blockId);
    const withCopy: TeamPrompts = held
      ? prompts
      : { ...prompts, blocks: [...prompts.blocks, { blockId, name: entry.name, text: entry.text }] };
    push(place(withCopy, blockId));
  };

  const unusedFor = (taken: readonly string[]): readonly PromptBlock[] =>
    library.filter((block) => !taken.includes(block.blockId));

  return (
    <div className={styles.section}>
      <div className={styles.subhead}>提示词</div>
      <div className={styles.hint}>
        片段来自你的提示词库，建团时拷贝一份到本队。每个席位读到的顺序是：全员的 → 集合的 → 它自己的职责。
      </div>
      {error === undefined ? null : <div className={styles.error}>{error}</div>}

      {open === undefined ? null : (
        <BlockEditor
          copy={open}
          library={library.find((block) => block.blockId === open.blockId)}
          edited={edited.has(open.blockId)}
          busy={busy}
          onClose={() => setEditing(undefined)}
          onSave={(next, alsoLibrary) => {
            // The team's copy first: a write-back that landed while the copy
            // failed would leave the library ahead of the team that wrote it.
            setBusy(true);
            setError(undefined);
            void api
              .setTeamPrompts({
                teamId: team.teamId,
                prompts: {
                  ...prompts,
                  blocks: prompts.blocks.map((block) => (block.blockId === next.blockId ? next : block)),
                },
              })
              .then(() => (alsoLibrary ? api.saveBlock(next) : undefined))
              .then(onChanged)
              .catch((problem: Error) => setError(problem.message))
              .finally(() => setBusy(false));
          }}
        />
      )}

      <div className={styles.card}>
        <div className={styles.row}>
          <span className={styles.teamName}>团队提示词</span>
          <span className={styles.muted}>选中的片段，全员都读</span>
        </div>
        <div className={styles.chips}>
          {prompts.teamBlockIds.map((blockId) => (
            <Chip
              key={blockId}
              label={nameOf(blockId) + (edited.has(blockId) ? " · 已改过" : "")}
              tone={edited.has(blockId) ? "warn" : "accent"}
              onOpen={() => setEditing(blockId)}
              onRemove={() => push({ ...prompts, teamBlockIds: prompts.teamBlockIds.filter((id) => id !== blockId) })}
            />
          ))}
          <select
            className={styles.field}
            value=""
            disabled={busy}
            onChange={(event) => {
              const blockId = event.target.value;
              if (blockId !== "") {
                adopt(blockId, (next, id) => ({ ...next, teamBlockIds: [...next.teamBlockIds, id] }));
              }
            }}
          >
            <option value="">＋ 加片段…</option>
            {unusedFor(prompts.teamBlockIds).map((block) => (
              <option key={block.blockId} value={block.blockId}>
                {block.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.row}>
        <span className={styles.teamName}>集合</span>
        <span className={styles.muted}>按顺序拼装 · 一个席位可以在多个集合里</span>
      </div>
      {prompts.sets.map((set, index) => (
        <SetCard
          key={set.setId}
          set={set}
          index={index}
          warnings={checkPromptSet(set, {
            blockIds: prompts.blocks.map((block) => block.blockId),
            seatIds: team.seats.map((seat) => seat.seatId),
          })
            .filter((problem) => problem.severity === "warning")
            .map((problem) => problem.detail)}
          team={team}
          prompts={prompts}
          library={library}
          edited={edited}
          busy={busy}
          nameOf={nameOf}
          onOpen={setEditing}
          onAdopt={adopt}
          onPush={push}
        />
      ))}
      <div className={styles.row}>
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          onClick={() =>
            push({
              ...prompts,
              sets: [
                ...prompts.sets,
                {
                  setId: `set-${Date.now().toString(36)}`,
                  name: `集合 ${prompts.sets.length + 1}`,
                  blockIds: [],
                  seatIds: [],
                },
              ],
            })
          }
        >
          新建集合
        </button>
        <span className={styles.hint}>先给它片段和席位，空集合不会有任何效果。</span>
      </div>

      <div className={styles.card}>
        <div className={styles.row}>
          <span className={styles.teamName}>实际读到的</span>
          <select className={styles.field} value={preview} onChange={(event) => setPreview(event.target.value)}>
            {team.seats.map((seat) => (
              <option key={seat.seatId} value={seat.seatId}>
                {seat.displayName}
              </option>
            ))}
          </select>
        </div>
        {/* The whole reason three tiers is affordable. 「这个席位为什么这么
            答」 must stay answerable in one place, and with inheritance it is
            only answerable here. */}
        <ol className={styles.planList}>
          {blocksForSeat(prompts, preview).map((block) => (
            <li key={block.blockId}>
              <strong>## {block.name}</strong>
              <span className={styles.muted}>
                {" "}
                ← {prompts.teamBlockIds.includes(block.blockId) ? "团队提示词" : "集合"}
              </span>
            </li>
          ))}
          <li>
            <strong>## 你的职责</strong>
            <span className={styles.muted}> ← 席位自己的提示词</span>
          </li>
        </ol>
      </div>
    </div>
  );
}

function SetCard({
  set,
  index,
  warnings,
  team,
  prompts,
  library,
  edited,
  busy,
  nameOf,
  onOpen,
  onAdopt,
  onPush,
}: {
  readonly set: PromptSet;
  readonly index: number;
  /** What is merely useless about it. Never a refusal — see `checkPromptSet`. */
  readonly warnings: readonly string[];
  readonly team: TeamSummary;
  readonly prompts: TeamPrompts;
  readonly library: readonly PromptBlock[];
  readonly edited: ReadonlySet<string>;
  readonly busy: boolean;
  readonly nameOf: (blockId: string) => string;
  readonly onOpen: (blockId: string) => void;
  readonly onAdopt: (blockId: string, use: (prompts: TeamPrompts, blockId: string) => TeamPrompts) => void;
  readonly onPush: (prompts: TeamPrompts) => void;
}): JSX.Element {
  // Typed locally, committed on blur.
  //
  // It used to push on every keystroke: each character POSTed the whole
  // prompts object, the snapshot came back, and the input was re-rendered
  // from the server's value mid-word. One round trip per character, and the
  // field fighting the person typing into it.
  const [name, setName] = useState(set.name);
  // Follows the record when it changes elsewhere, but never while this field
  // is being edited — otherwise a poll two seconds later wipes the word in
  // progress, which is the bug in a slower disguise.
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!typing) setName(set.name);
  }, [set.name, typing]);

  const commitName = (): void => {
    setTyping(false);
    if (name === set.name) return;
    onPush(replace({ ...set, name }));
  };

  const replace = (next: PromptSet): TeamPrompts => ({
    ...prompts,
    sets: prompts.sets.map((one) => (one.setId === set.setId ? next : one)),
  });
  const move = (to: number): void => {
    const sets = [...prompts.sets];
    const [held] = sets.splice(index, 1);
    if (held === undefined) return;
    sets.splice(Math.max(0, Math.min(sets.length, to)), 0, held);
    onPush({ ...prompts, sets });
  };

  return (
    <div className={styles.card}>
      <div className={styles.row}>
        <input
          className={styles.field}
          value={name}
          placeholder="集合的名字，比如「产出型席位」"
          onChange={(event) => {
            setTyping(true);
            setName(event.target.value);
          }}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <button type="button" className={styles.button} disabled={busy || index === 0} onClick={() => move(index - 1)}>
          ↑
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={busy || index === prompts.sets.length - 1}
          onClick={() => move(index + 1)}
        >
          ↓
        </button>
        <button
          type="button"
          className={styles.drop}
          onClick={() => {
            if (window.confirm(`删掉集合「${set.name}」？片段本身还在，只是不再挂给这些席位。`)) {
              onPush({ ...prompts, sets: prompts.sets.filter((one) => one.setId !== set.setId) });
            }
          }}
        >
          删除
        </button>
      </div>

      {/* On the card that has them, not at the top of the section. A warning
          about 「集合 1」 printed above every set is a warning nobody can
          place — and while it sat there in red it read as a refusal, which
          is exactly what it is not. */}
      {warnings.map((warning) => (
        <div key={warning} className={styles.hint}>
          ⚠ {warning}
        </div>
      ))}
      <div className={styles.muted}>片段</div>
      <div className={styles.chips}>
        {set.blockIds.map((blockId) => (
          <Chip
            key={blockId}
            label={nameOf(blockId) + (edited.has(blockId) ? " · 已改过" : "")}
            tone={edited.has(blockId) ? "warn" : "accent"}
            onOpen={() => onOpen(blockId)}
            onRemove={() => onPush(replace({ ...set, blockIds: set.blockIds.filter((id) => id !== blockId) }))}
          />
        ))}
        <select
          className={styles.field}
          value=""
          disabled={busy}
          onChange={(event) => {
            const blockId = event.target.value;
            if (blockId !== "") {
              onAdopt(blockId, (next, id) => ({
                ...next,
                sets: next.sets.map((one) =>
                  one.setId === set.setId ? { ...one, blockIds: [...one.blockIds, id] } : one,
                ),
              }));
            }
          }}
        >
          <option value="">＋ 加片段…</option>
          {library
            .filter((block) => !set.blockIds.includes(block.blockId))
            .map((block) => (
              <option key={block.blockId} value={block.blockId}>
                {block.name}
              </option>
            ))}
        </select>
      </div>

      <div className={styles.muted}>席位</div>
      <div className={styles.chips}>
        {set.seatIds.map((seatId) => (
          <Chip
            key={seatId}
            label={team.seats.find((seat) => seat.seatId === seatId)?.displayName ?? seatId}
            onRemove={() => onPush(replace({ ...set, seatIds: set.seatIds.filter((id) => id !== seatId) }))}
          />
        ))}
        <select
          className={styles.field}
          value=""
          disabled={busy}
          onChange={(event) => {
            const seatId = event.target.value;
            if (seatId !== "") onPush(replace({ ...set, seatIds: [...set.seatIds, seatId] }));
          }}
        >
          <option value="">＋ 加席位…</option>
          {team.seats
            .filter((seat) => !set.seatIds.includes(seat.seatId))
            .map((seat) => (
              <option key={seat.seatId} value={seat.seatId}>
                {seat.displayName}
              </option>
            ))}
        </select>
      </div>
    </div>
  );
}
