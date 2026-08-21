/**
 * service.ts — `ctx.seatConnections`: what a seat runs on.
 *
 * One owner, three consumers: the seat backend applies a connection's
 * environment, the table resolves which connection a seat uses, and the
 * console renders and edits them. None of those may import each other, so the
 * library is its own plugin rather than a corner of one of them.
 *
 * Credentials are never held here. `describe()` answers whether one is
 * configured without reading it — DSH built that method for configuration
 * UIs, and it is the reason a settings screen can show a "configured" badge
 * without a secret ever entering the browser.
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import type { Domain } from "@deepseek-ai/dsh-storage-domain";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { checkConnection, envForConnection, type SeatConnection } from "@squad/shared";
import { SQUAD_CONNECTIONS_DOMAIN } from "./domain.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    seatConnections: SeatConnectionsService;
  }
}

/** A connection as a configuration screen may see it: no secret, ever. */
export interface ConnectionView extends SeatConnection {
  /** Whether the referenced credential resolves right now. */
  readonly credentialConfigured: boolean;
  /** Whether this surface could write it, or a read-only source shadows it. */
  readonly credentialWritable: boolean;
}

export class SeatConnectionsService extends Service {
  static readonly inject = ["storageDomain", "credentials"];

  private domain: Domain<typeof SQUAD_CONNECTIONS_DOMAIN> | undefined;
  private readonly watchers = new Set<() => void>();

  constructor(ctx: Context) {
    super(ctx, "seatConnections");
  }

  async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(SQUAD_CONNECTIONS_DOMAIN);
    this.domain = domain;
    this.ctx.effect(() => async () => {
      this.domain = undefined;
      await domain.close();
    });
  }

  /** Every connection, oldest first. */
  list(): readonly SeatConnection[] {
    return [...this.table().entries()].map(([, record]) => record).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(connectionId: string): SeatConnection | undefined {
    return this.table().get(connectionId);
  }

  /**
   * Save a connection.
   *
   * Validated through the shared rules rather than re-checked here: the
   * endpoint-on-a-subscription and foreign-model cases are refusals, not
   * warnings, and a second copy of those rules would eventually accept
   * something the first one refuses.
   */
  async save(connection: SeatConnection): Promise<void> {
    const problems = checkConnection(connection);
    if (problems.length > 0) throw new Error(problems.map((problem) => problem.detail).join("\n"));
    const existing = this.table().get(connection.connectionId);
    await this.table().put(connection.connectionId, {
      ...connection,
      createdAt: existing?.createdAt ?? Date.now(),
    });
    this.announce();
  }

  async remove(connectionId: string): Promise<void> {
    await this.table().delete(connectionId);
    this.announce();
  }

  /**
   * What a configuration screen may see.
   *
   * `describe` is asked per connection rather than the credential being read:
   * the answer needed is "is it set up", and reading the value to find out
   * would put a secret somewhere it never had to be.
   */
  async views(): Promise<readonly ConnectionView[]> {
    const views: ConnectionView[] = [];
    for (const connection of this.list()) {
      const ref = (connection.credentialRef ?? "").trim();
      if (ref === "") {
        views.push({ ...connection, credentialConfigured: false, credentialWritable: true });
        continue;
      }
      const described = await this.ctx.credentials.describe(credentialRef(ref));
      views.push({
        ...connection,
        credentialConfigured: described.configured,
        credentialWritable: described.writable,
      });
    }
    return views;
  }

  /** Store a secret under a connection's reference. The value never lands here. */
  async setCredential(connectionId: string, value: string): Promise<void> {
    const connection = this.get(connectionId);
    if (connection === undefined) throw new Error(`没有这个连接：${connectionId}。`);
    const ref = (connection.credentialRef ?? "").trim();
    if (ref === "") throw new Error("这个连接没有凭据引用。");
    await this.ctx.credentials.set(credentialRef(ref), value);
  }

  /**
   * The environment this connection contributes to a seat's process.
   *
   * Resolved per call, never cached: that is what makes a rotated key reach
   * the next turn instead of the next restart.
   */
  async envFor(connectionId: string): Promise<Readonly<Record<string, string>>> {
    const connection = this.get(connectionId);
    if (connection === undefined) throw new Error(`没有这个连接：${connectionId}。`);
    if (connection.authMode === "subscription") return envForConnection(connection);
    const ref = (connection.credentialRef ?? "").trim();
    const hit = ref === "" ? undefined : await this.ctx.credentials.resolve(credentialRef(ref));
    return envForConnection(connection, hit?.value);
  }

  /**
   * Watch the library for changes.
   *
   * The seat backend keeps one provider registration per connection, so it
   * has to learn about a new one without a restart — a connection you just
   * created and cannot use until you relaunch is a connection that does not
   * work.
   */
  watch(listener: () => void): () => void {
    this.watchers.add(listener);
    return () => {
      this.watchers.delete(listener);
    };
  }

  private announce(): void {
    for (const listener of [...this.watchers]) {
      try {
        listener();
      } catch (error) {
        // One bad watcher must not stop the others from learning.
        this.ctx.logger.warn(`连接库通知失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private table() {
    if (this.domain === undefined) throw new Error("连接库尚未启动（storage domain 未打开）。");
    return this.domain.table("connections");
  }
}
