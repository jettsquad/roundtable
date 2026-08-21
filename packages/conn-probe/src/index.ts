/**
 * @squad/conn-probe — a one-off check that the connection library behaves.
 *
 * Mounted by hand, never shipped. It exercises the two paths that matter and
 * cannot be checked from a unit test: that a credential set through
 * `ctx.credentials` comes back inside a seat's environment, and that a
 * subscription connection contributes nothing at all.
 */
import type { Context } from "@deepseek-ai/cordis";

export const name = "squad-conn-probe";
export const inject = ["seatConnections"];

export function apply(ctx: Context): void {
  void (async () => {
    const line = (text: string) => process.stdout.write(`[conn] ${text}\n`);
    try {
      await ctx.seatConnections.save({
        connectionId: "gw",
        displayName: "自建网关",
        authMode: "api-key",
        backend: "claude-code",
        endpoint: "https://gateway.example/v1",
        credentialRef: "SQUAD_PROBE_KEY",
        modelId: "deepseek-chat",
      });
      await ctx.seatConnections.setCredential("gw", "sk-probe-12345");
      const withKey = await ctx.seatConnections.envFor("gw");
      line(`api-key 连接的 env：${JSON.stringify(withKey)}`);
      line(
        `  端点在=${withKey["ANTHROPIC_BASE_URL"] !== undefined}，token 在=${withKey["ANTHROPIC_AUTH_TOKEN"] !== undefined}`,
      );

      await ctx.seatConnections.save({
        connectionId: "login",
        displayName: "本机登录",
        authMode: "subscription",
        backend: "claude-code",
        modelId: "sonnet",
      });
      const sub = await ctx.seatConnections.envFor("login");
      line(`订阅连接的 env：${JSON.stringify(sub)}`);
      line(
        `  没有 token=${sub["ANTHROPIC_AUTH_TOKEN"] === undefined}，没有端点=${sub["ANTHROPIC_BASE_URL"] === undefined}`,
      );

      const views = await ctx.seatConnections.views();
      for (const view of views) {
        line(
          `视图：${view.displayName} · ${view.authMode} · 凭据已配=${view.credentialConfigured} · 可写=${view.credentialWritable}`,
        );
        if (JSON.stringify(view).includes("sk-probe")) line("  ❌ 视图里带出了密钥！");
      }
      line("结束。");
    } catch (error) {
      line(`失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  })();
}
