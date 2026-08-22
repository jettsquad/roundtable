/**
 * wire.ts — what crosses `/api/squad`, and nothing else.
 *
 * Its own module, imported by both halves, because the two halves compile
 * under different programs: the host half against node, the browser half
 * against the DOM with no node types at all. A shape defined next to
 * `IncomingMessage` cannot be imported by the browser's typechecker even as a
 * type — the import drags the whole node-facing module into that program.
 *
 * So this file imports nothing but `@squad/shared`, which is pure by
 * construction. That constraint is the point: it is what makes the panel's
 * types come from the route that produces them rather than from a hand-kept
 * second declaration, and a second declaration of a wire format is a bug
 * waiting for a field rename.
 */
import type {
  AgendaSpec,
  AgentTemplate,
  ConnectionView,
  PermissionMode,
  SeatCaps,
  SeatConnection,
  UsageTotals,
} from "@squad/shared";

export interface TeamSummary {
  readonly teamId: string;
  readonly displayName: string;
  readonly projectFolder: string;
  /** What the host is called in the record, so a view can tell it from a seat. */
  readonly hostDisplayName: string;
  readonly busy: boolean;
  readonly seats: readonly {
    readonly seatId: string;
    readonly displayName: string;
    readonly role: string;
    readonly isSecretary: boolean;
    /** Speaking right now. */
    readonly running: boolean;
    readonly connectionId?: string | undefined;
    readonly caps?: SeatCaps | undefined;
    readonly permissionMode?: PermissionMode | undefined;
    /** Where this seat came from, when it was taken from the library. */
    readonly templateId?: string | undefined;
    readonly color?: string | undefined;
    /**
     * Why this seat cannot run, when it cannot.
     *
     * Computed from what is actually registered, not from a list of backends
     * someone believed were built. A seat whose backend has no plugin fails
     * at the moment the round starts, having sent nothing — and until this
     * existed the panel let you start that round anyway and showed you the
     * provider name afterwards.
     */
    readonly blocked?: string | undefined;
    /** The seat's own standing instructions, so a roster can be inspected. */
    readonly systemPrompt: string;
    readonly backend: string;
  }[];
  /** Where a running agenda has got to, when one is running. */
  readonly progress?:
    | {
        readonly phase: string;
        readonly phaseIndex: number;
        readonly phaseCount: number;
        readonly completedPhases: number;
      }
    | undefined;
  /**
   * A draft the secretary wrote, waiting on the host.
   *
   * Held on the SERVER, not in the panel, because the confirmation is the
   * decision this product exists to keep with a person: a draft that lived
   * only in one browser tab would be lost by a reload and invisible to every
   * other surface, and the host would confirm from memory.
   */
  readonly draft?: AgendaSpec | undefined;
  /** Lines of recorded discussion. */
  readonly recorded: number;
  /** What this team's seats have consumed, when any backend reported it. */
  readonly usage: UsageTotals;
  /**
   * The discussion, most recent last.
   *
   * Bounded: only the tail travels. The whole record can be thousands of
   * lines and the panel polls every two seconds — sending all of it would
   * make reading the roster cost more than holding the meeting.
   */
  readonly transcript: readonly { readonly speaker: string; readonly text: string; readonly turnId: string }[];
  /** How much of the discussion the tail left out. */
  readonly transcriptOmitted: number;
}

export interface SquadSnapshot {
  readonly teams: readonly TeamSummary[];
  /**
   * Lil X's judgement library.
   *
   * The counts used to be the whole of it, which made the header badge a
   * dead end: it said one proposal was waiting and offered no way to look at
   * it. A number that names an obligation has to lead somewhere.
   */
  readonly criteria: {
    readonly active: number;
    readonly pending: number;
    /** Proposals awaiting a human verdict. */
    readonly proposals: readonly CriterionView[];
    /** Criteria already in force, with what their use has shown. */
    readonly live: readonly CriterionView[];
  };
  /** Seat connections, with credential STATUS and never a credential value. */
  readonly connections: readonly PanelConnection[];
  /** The reusable agent library. */
  readonly agents: readonly AgentTemplate[];
  /**
   * How this host lets a person choose a folder.
   *
   * In the snapshot rather than asked per click, because the answer decides
   * which control to draw: a button that opens an OS dialog, or an in-app
   * browser. Drawing the browser and finding out afterwards would show the
   * clumsy one to every machine that had the good one.
   */
  readonly picker: PickerKind;
}

/** One agent taken from the library into a new team. */
export interface TeamMember {
  readonly templateId: string;
  readonly isSecretary?: boolean;
}

/**
 * Building a team, two ways in.
 *
 * `members` is the panel: agents picked off the library, already configured.
 * `roster` is the slash command's text grammar, which stays because typing
 * is the right interaction in a command line and the wrong one in a form —
 * the form had a person retyping names that were already in the library, and
 * then spelling a `*` to mark a secretary the library already knew could be
 * one.
 *
 * When both arrive, `members` wins: it is the one that carries configuration
 * rather than just names.
 */
export interface CreateTeamRequest {
  readonly displayName?: string;
  readonly projectFolder?: string;
  readonly roster?: string;
  readonly members?: readonly TeamMember[];
}

/** Adding or removing one seat. */
export interface SeatRequest {
  readonly teamId: string;
  /**
   * Adding from the library: which agent.
   *
   * Preferred over spelling the fields out, because the template is the thing
   * a person configured and can inspect later — a seat assembled field by
   * field looks identical afterwards and carries no answer to "where did this
   * one come from".
   */
  readonly templateId?: string;
  /** Adding by hand: the new seat. */
  readonly displayName?: string;
  readonly role?: string;
  readonly isSecretary?: boolean;
  /** Removing: which one. */
  readonly seatId?: string;
  /** Removing the secretary takes a deliberate confirmation. */
  readonly confirmSecretary?: boolean;
}

/**
 * Editing a seat in place.
 *
 * `connectionId: ""` means the host's own login — a real choice, and
 * distinguishable from `undefined`, which means "leave this alone".
 */
export interface SeatPatch {
  readonly teamId: string;
  readonly seatId: string;
  readonly connectionId?: string;
  readonly caps?: SeatCaps;
}

/**
 * Saving a connection.
 *
 * `credential` travels IN and never comes back out: the route hands it to the
 * credential service and drops it, and no response or snapshot carries a
 * credential value. That asymmetry is why the connection record is safe to
 * read and render.
 */
export type ConnectionRequest = SeatConnection & { readonly credential?: string };

/**
 * Saving an agent template.
 *
 * `credential` and the connection fields are here because a person creating
 * an agent is usually creating its connection in the same breath — 1.x put
 * model, endpoint and key on the agent form for exactly that reason. The
 * route builds or reuses a connection and stores the secret through the
 * credential service; the template itself only ever holds a connection ID.
 */
export interface AgentRequest extends Omit<AgentTemplate, "enabled"> {
  /** When set, create/update this connection and point the template at it. */
  readonly connection?: SeatConnection & { readonly credential?: string };
}

/**
 * How this host lets a person choose a folder.
 *
 * `native` opens one OS chooser on the host's display; `browse` serves
 * listing primitives for an in-app browser, which is what a remote client
 * gets because no OS dialog can reach it. The distinction is dsh's own seam
 * (`ctx.directoryPicker`) and this carries it rather than deciding for it —
 * hand-rolling a `readdir` route was the first version, and it meant a
 * machine with a real file dialog never got to use it.
 */
export type PickerKind = "native" | "browse" | "none";

/** One directory row: a listing child, or a breadcrumb ancestor. */
export interface DirectoryEntry {
  readonly name: string;
  /** Absolute host path. Clients never join segments themselves. */
  readonly path: string;
  readonly hidden: boolean;
}

/** One directory level plus its ancestry, as a browse backend reports it. */
export interface DirectoryListing {
  readonly kind: PickerKind;
  readonly path: string;
  readonly home: string;
  /** Root → this directory, inclusive. Every crumb is a jump target. */
  readonly crumbs: readonly DirectoryEntry[];
  readonly entries: readonly DirectoryEntry[];
  /** The level has more children than reported; the missing ones are the tail. */
  readonly truncated: boolean;
}

/** The outcome of one native chooser. `null` path means the person cancelled. */
export interface NativePickResult {
  readonly path: string | null;
}

/** One criterion, flattened for the panel. */
export interface CriterionView {
  readonly id: string;
  /** The claim, in the person's own words. */
  readonly claim: string;
  /** Where it does NOT apply. */
  readonly boundary?: string;
  readonly status: "active" | "suspect" | "retired";
  /** How many recorded occurrences back it. */
  readonly evidence: number;
  /** When it gets fetched: action kinds, feature flags, framework steps. */
  readonly trigger: {
    readonly action: readonly string[];
    readonly features: readonly string[];
    readonly step?: readonly string[];
  };
  /**
   * What its use has shown, when it has been used.
   *
   * Absent for a proposal — a criterion nobody has been given yet has no
   * record, and a health verdict on it would be an opinion dressed as one.
   */
  readonly health?: { readonly verdict: string; readonly detail: string };
}

/** A human's verdict on one proposal. */
export interface CriterionVerdictRequest {
  readonly id: string;
  readonly verdict: "accept" | "reject";
}

/**
 * A connection as the panel sees it.
 *
 * `providerReady` is added HERE rather than on the library's own view: the
 * connection library has no business knowing which seat backends registered
 * what, and asking it to would be the first thread pulling those two apart.
 * The console has the registry, so the console answers.
 *
 * Asked rather than derived from a list of backends someone believed were
 * built — the badge was once hardcoded to `backend === "claude-code"` and
 * went on saying 「还没有 codex 的席位插件」 after the codex plugin shipped.
 */
export interface PanelConnection extends ConnectionView {
  readonly providerReady: boolean;
}

/** Asking the secretary to turn a plain instruction into phases. */
export interface DraftAgendaRequest {
  readonly teamId: string;
  /** The host's own words. `@` references are refused — the secretary is private-blind. */
  readonly command: string;
}

/** The host's verdict on a draft. */
export interface AgendaVerdictRequest {
  readonly teamId: string;
  readonly verdict: "confirm" | "discard";
  /** An edited draft replaces the held one; absent confirms it as written. */
  readonly agenda?: AgendaSpec;
}
