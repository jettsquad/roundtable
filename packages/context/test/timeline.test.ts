/**
 * The bug this layer exists for: 1.x's renderer ended in a catch-all that
 * returned nothing for any kind it had not been taught, so the context
 * checkpoint was cut out of history by the window and then thrown away here.
 * History gone, replacement gone, no error.
 */
import { describe, expect, it } from "vitest";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import {
  CHECKPOINT_TIMELINE_PREFIX,
  HOST_TURN_KINDS,
  SPEECH_KIND,
  TIMELINE_IGNORED_KINDS,
  renderTimeline,
  renderTimelineEvent,
} from "../src/timeline.ts";
import { CHECKPOINT_KIND, type SelectableEvent } from "../src/window.ts";

const speech = (text: string): SelectableEvent => ({ kind: SPEECH_KIND, text });
const checkpoint = (text: string): SelectableEvent => ({ kind: CHECKPOINT_KIND, text });

describe("renderTimelineEvent", () => {
  it("renders a line of the discussion", () => {
    expect(renderTimelineEvent(speech("【甲】我认为可以"))).toBe("【甲】我认为可以");
  });

  it("renders the checkpoint, and says what it is", () => {
    // The regression this module exists for: the checkpoint must reach the
    // seat, and it must arrive labelled — unlabelled it reads as somebody's
    // opinion rather than as a stand-in for detail that still exists.
    const line = renderTimelineEvent(checkpoint("要点一、要点二"));
    expect(line).toBe(`${CHECKPOINT_TIMELINE_PREFIX}\n\n要点一、要点二`);
  });

  it("strips reasoning again at render time", () => {
    // The log keeps what was recorded. A turn recorded before replies were
    // cleaned would otherwise go on feeding its reasoning to a seat.
    expect(renderTimelineEvent(speech("<think>盘算一下</think>结论是 A"))).toBe("结论是 A");
  });

  it("returns undefined for a kind that is deliberately not shown", () => {
    expect(renderTimelineEvent({ kind: "session/title" })).toBeUndefined();
  });

  it("throws on a kind it has never been taught", () => {
    // The whole point: a new event kind fails loudly at introduction rather
    // than becoming a hole in what the seats can see.
    expect(() => renderTimelineEvent({ kind: "squad/somethingNew" })).toThrow(/未知事件类型/);
  });

  it("throws when the host node turns out to have run a turn", () => {
    // Not a rendering question. Only a turn produces these, and a host node
    // that took a turn means an LLM chaired the meeting.
    expect(() => renderTimelineEvent({ kind: "assistant/message" })).toThrow(/锚点不是决策者/);
    expect(() => renderTimelineEvent({ kind: "turn/start" })).toThrow(/跑过一个回合/);
  });
});

describe("renderTimeline", () => {
  it("keeps transcript order and drops only the ignored kinds", () => {
    expect(
      renderTimeline([checkpoint("此前要点"), { kind: "session/title" }, speech("【主持人】继续"), speech("【甲】好")]),
    ).toEqual([`${CHECKPOINT_TIMELINE_PREFIX}\n\n此前要点`, "【主持人】继续", "【甲】好"]);
  });
});

describe("the three tables cover the harness vocabulary", () => {
  // `.dsh-link.json` records which harness build we bound to and warns when it
  // moves. This is the other half of that guard: a harness that grew a new
  // event type must fail here, in a test naming the type, rather than in a
  // seat quietly not seeing something.
  const rendered = new Set([SPEECH_KIND, CHECKPOINT_KIND]);

  it("files every known dsh event type in exactly one table", () => {
    const unfiled: string[] = [];
    const doubleFiled: string[] = [];
    for (const type of KNOWN_SESSION_EVENT_TYPES) {
      const tables = [rendered, TIMELINE_IGNORED_KINDS, HOST_TURN_KINDS].filter((table) => table.has(type)).length;
      if (tables === 0) unfiled.push(type);
      if (tables > 1) doubleFiled.push(type);
    }
    expect({ unfiled, doubleFiled }).toEqual({ unfiled: [], doubleFiled: [] });
  });

  it("renders or throws for every known type — never silently nothing it was not asked to ignore", () => {
    for (const type of KNOWN_SESSION_EVENT_TYPES) {
      if (TIMELINE_IGNORED_KINDS.has(type)) {
        expect(renderTimelineEvent({ kind: type })).toBeUndefined();
      } else {
        expect(() => renderTimelineEvent({ kind: type })).not.toThrow(/未知事件类型/);
      }
    }
  });
});
