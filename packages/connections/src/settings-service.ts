/**
 * settings-service.ts — `ctx.userSettings`: what is true of the person.
 *
 * Deliberately tiny, and deliberately its own service rather than a field
 * bolted onto the connection library. What belongs here is everything that
 * outlives every team — a name today, and whatever else turns out to be a
 * fact about the user rather than about a roster. Growing it is adding a
 * field; finding it later is reading one file.
 */
import { Service, type Context } from "@deepseek-ai/cordis";
import type { Domain } from "@deepseek-ai/dsh-storage-domain";
import { hostNameOrDefault } from "@squad/shared";
import { SETTINGS_KEY, SQUAD_SETTINGS_DOMAIN } from "./settings-domain.ts";

declare module "@deepseek-ai/cordis" {
  interface Context {
    userSettings: UserSettingsService;
  }
}

export class UserSettingsService extends Service {
  static readonly inject = ["storageDomain"];

  private domain: Domain<typeof SQUAD_SETTINGS_DOMAIN> | undefined;

  constructor(ctx: Context) {
    super(ctx, "userSettings");
  }

  async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(SQUAD_SETTINGS_DOMAIN);
    this.domain = domain;
    this.ctx.effect(() => async () => {
      this.domain = undefined;
      await domain.close();
    });
  }

  /**
   * The name to use at a table, always a usable one.
   *
   * Falls back rather than returning nothing, because every caller wants a
   * string to put in a prompt and none of them has anything better to do with
   * an `undefined` than substitute this same default.
   */
  hostDisplayName(): string {
    return hostNameOrDefault(this.table().get(SETTINGS_KEY)?.hostDisplayName);
  }

  /** Whether the person has actually chosen, for a screen that wants to say so. */
  hasHostDisplayName(): boolean {
    const stored = this.table().get(SETTINGS_KEY)?.hostDisplayName?.trim();
    return stored !== undefined && stored !== "";
  }

  /**
   * Set the name. Clearing it goes back to the default rather than to blank.
   *
   * A blank name would reach a seat's prompt as 「主持人：」 followed by
   * nothing, which a model reads as a broken field rather than as a person —
   * so emptying the box means "use the default", not "have no name".
   */
  async setHostDisplayName(name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length > 40) throw new Error("名字太长了，讨论记录里每一行都要带着它。");
    const existing = this.table().get(SETTINGS_KEY);
    await this.table().put(SETTINGS_KEY, {
      ...existing,
      ...(trimmed === "" ? { hostDisplayName: undefined } : { hostDisplayName: trimmed }),
      updatedAt: Date.now(),
    });
  }

  private table() {
    if (this.domain === undefined) throw new Error("用户设置尚未启动（storage domain 未打开）。");
    return this.domain.table("settings");
  }
}
