/**
 * backend-tools.tsx — the CLIs seats run on, and the button that upgrades one.
 *
 * Next to the agents because that is where a person is when a seat fails for
 * a reason that is not the seat's: an old CLI answers 「model is not
 * supported」 about a model the same account can use from a newer one, and
 * nothing in that message says "upgrade".
 */
import { useEffect, useState } from "react";
import { api, type BackendTool, type ToolStatus, type UpgradeReport } from "./api.ts";
import { useT } from "./locale.ts";
import styles from "./panel.module.css";

const NAMES: Readonly<Record<BackendTool, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  dsh: "dsh",
};

export function BackendTools(): JSX.Element {
  const t = useT();
  const [tools, setTools] = useState<readonly ToolStatus[] | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  // Which tool is waiting for the second click. Upgrading replaces a program
  // installed for the whole machine, so it takes two: one to see what would
  // change, one to change it.
  const [confirming, setConfirming] = useState<BackendTool>();
  const [upgrading, setUpgrading] = useState<BackendTool>();
  const [reports, setReports] = useState<Partial<Record<BackendTool, UpgradeReport>>>({});

  const check = (): void => {
    setChecking(true);
    setError(undefined);
    void api
      .tools()
      .then((result) => setTools(result.tools))
      .catch((failure: Error) => setError(String(failure.message)))
      .finally(() => setChecking(false));
  };
  // Once, when the page opens. Not polled: each look costs three process
  // spawns and three lookups, and a version does not change while you watch.
  useEffect(check, []);

  const upgrade = (tool: BackendTool): void => {
    setConfirming(undefined);
    setUpgrading(tool);
    setError(undefined);
    void api
      .upgradeTool({ tool })
      .then((report) => {
        setReports((current) => ({ ...current, [tool]: report }));
        check();
      })
      .catch((failure: Error) => setError(String(failure.message)))
      .finally(() => setUpgrading(undefined));
  };

  return (
    <div className={styles.toolsBlock}>
      <div className={styles.row}>
        <div className={styles.subhead}>{t("tools.head")}</div>
        <button type="button" className={styles.button} disabled={checking || upgrading !== undefined} onClick={check}>
          {checking ? t("tools.checking") : t("tools.check")}
        </button>
      </div>
      {tools === undefined ? null : (
        <div className={styles.toolsList}>
          {tools.map((tool) => {
            const report = reports[tool.tool];
            return (
              <div key={tool.tool} className={styles.toolRow}>
                <div className={styles.row}>
                  <span className={styles.toolName}>{NAMES[tool.tool]}</span>
                  <span className={tool.outdated ? styles.toolOutdated : styles.muted}>
                    {tool.installed === undefined
                      ? t("tools.notRunning")
                      : tool.outdated
                        ? t("tools.outdated", { installed: tool.installed, latest: tool.latest ?? "" })
                        : tool.latest === undefined
                          ? t("tools.installed", { installed: tool.installed })
                          : t("tools.current", { installed: tool.installed })}
                  </span>
                  {!tool.canUpgrade ? null : upgrading === tool.tool ? (
                    <span className={styles.muted}>{t("tools.upgrading")}</span>
                  ) : confirming === tool.tool ? (
                    <>
                      <button type="button" className={styles.button} onClick={() => upgrade(tool.tool)}>
                        {tool.installed === undefined || tool.latest === undefined
                          ? t("tools.confirmRepair")
                          : t("tools.confirm", { installed: tool.installed, latest: tool.latest })}
                      </button>
                      <button type="button" className={styles.drop} onClick={() => setConfirming(undefined)}>
                        {t("tools.cancel")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={styles.button}
                      disabled={upgrading !== undefined}
                      onClick={() => setConfirming(tool.tool)}
                    >
                      {tool.installed === undefined ? t("tools.repair") : t("tools.upgrade")}
                    </button>
                  )}
                </div>
                {tool.problem === undefined ? null : <div className={styles.hint}>{tool.problem}</div>}
                {/* The command, shown before it is run: it changes a program
                    installed for the whole machine, and a person should be
                    able to see exactly what a button is about to do there. */}
                {confirming !== tool.tool || tool.upgradeCommand === undefined ? null : (
                  <div className={styles.hint}>{t("tools.willRun", { command: tool.upgradeCommand })}</div>
                )}
                {report === undefined ? null : report.ok ? (
                  <div className={styles.muted}>
                    {/* The installer ran and the version did not move: its own
                        channel has nothing newer yet. Said as that, not as an
                        upgrade that "completed" from a version to itself. */}
                    {report.before !== undefined && report.before === report.after
                      ? t("tools.unchanged", { version: report.after ?? "?" })
                      : t("tools.done", { before: report.before ?? "?", after: report.after ?? "?" })}
                  </div>
                ) : (
                  <>
                    <div className={styles.error}>{t("tools.failed")}</div>
                    <pre className={styles.toolLog}>{report.log}</pre>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {error === undefined ? null : <div className={styles.error}>{error}</div>}
    </div>
  );
}
