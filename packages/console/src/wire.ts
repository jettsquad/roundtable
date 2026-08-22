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
    /** The seat's own standing instructions, so a roster can be inspected. */
    readonly systemPrompt: string;
    readonly backend: string;
  }[];
  /** Where a running agenda has got to, when one is running. */
  readonly progress?: { readonly phase: string; readonly phaseIndex: number; readonly phaseCount: number } | undefined;
  /** Lines of recorded discussion. */
  readonly recorded: number;
  /** What this team's seats have consumed, when any backend reported it. */
  readonly usage: UsageTotals;
}

export interface SquadSnapshot {
  readonly teams: readonly TeamSummary[];
  /** Lil X: how many criteria are live, and how many wait on a human. */
  readonly criteria: { readonly active: number; readonly pending: number };
  /** Seat connections, with credential STATUS and never a credential value. */
  readonly connections: readonly ConnectionView[];
  /** The reusable agent library. */
  readonly agents: readonly AgentTemplate[];
}

/** Building a team: the three fields, in the grammar the command uses. */
export interface CreateTeamRequest {
  readonly displayName?: string;
  readonly projectFolder?: string;
  readonly roster?: string;
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

/** One directory, as the folder picker sees it. */
export interface DirectoryListing {
  readonly path: string;
  /** The parent, absent at the filesystem root. */
  readonly parent?: string;
  /** Direct child directories, by name, sorted. Files are not listed. */
  readonly directories: readonly string[];
}
