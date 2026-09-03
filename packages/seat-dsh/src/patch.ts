/**
 * patch.ts — telling a headless DSH which model to use.
 *
 * Without this, a DSH seat runs the stock `headless` profile, which routes to
 * DeepSeek's own endpoint. A connection's endpoint and model were stored,
 * shown in the library, and then ignored — so a MiniMax key was being sent to
 * DeepSeek's API and came back 「Authentication Fails」, blaming the key for a
 * request that had gone to the wrong company.
 *
 * 1.x got this right and the mechanism is carried over: write a one-shot
 * profile patch and pass `--patch`. Two shapes, because DSH routes DeepSeek's
 * own models through a dedicated provider and everything else through the
 * OpenAI-compatible one:
 *
 *   deepseek-*  → point `llm-deepseek` at the baseURL
 *   anything else → declare one provider on `llm-pi-ai`, which the base
 *                   bundle already mounts DORMANT (no routes until a profile
 *                   supplies entries). Configuring that instance rather than
 *                   adding a second matters: a second one re-declares pi-ai's
 *                   configurable providers and the whole tree refuses to load
 *                   with 「configurable provider … is already declared」.
 *
 * The KEY never enters the file — only the name of the variable carrying it.
 * The patch is a file on disk; a secret written there would outlive the run.
 */

/**
 * The heartbeat plugin's row, by absolute path.
 *
 * An absolute path rather than a package name because the child resolves
 * names from ITS profile directory, where nothing of ours is installed —
 * measured: a `--patch` row naming a `.ts` file by absolute path loads fine,
 * which is what lets this ship without installing a profile anywhere.
 */
export function heartbeatRows(modulePath: string): readonly string[] {
  return ["- insert:", "    - id: squad-seat-heartbeat", `      name: ${JSON.stringify(modulePath)}`];
}

/** The provider id a non-DeepSeek model is routed through. */
export const COMPAT_ROUTE = "squad-compat";
/** The variable the compat provider reads its key from. */
export const COMPAT_API_KEY_ENV = "SQUAD_LLM_API_KEY";

/** Whether DSH routes this model through its own DeepSeek provider. */
export function isDeepSeekModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("deepseek");
}

export interface PatchInput {
  readonly model: string;
  /** Empty means the profile's own default endpoint. */
  readonly baseUrl: string;
}

/**
 * The patch text for one run, or `undefined` when there is nothing to say.
 *
 * `undefined` when no model was configured: the profile's own settings are
 * then the answer, and writing a patch that repeated them would be a second
 * place for the same decision to live.
 */
export function buildDshPatch(input: PatchInput): string | undefined {
  const model = input.model.trim();
  const baseUrl = input.baseUrl.trim();
  if (model === "") return undefined;

  const lines: readonly string[] = isDeepSeekModel(model)
    ? [
        "- id: agent-default-model",
        "  config:",
        "    provider: deepseek-official",
        `    model: ${JSON.stringify(model)}`,
        ...(baseUrl === "" ? [] : ["- id: llm-deepseek", "  config:", `    baseURL: ${JSON.stringify(baseUrl)}`]),
      ]
    : [
        "- id: agent-default-model",
        "  config:",
        `    provider: ${COMPAT_ROUTE}`,
        `    model: ${JSON.stringify(model)}`,
        "- id: llm-pi-ai",
        "  config:",
        "    providers:",
        `      ${COMPAT_ROUTE}:`,
        "        displayName: Squad OpenAI-compatible",
        `        apiKeyEnv: ${COMPAT_API_KEY_ENV}`,
        "        api: openai-completions",
        `        baseURL: ${JSON.stringify(baseUrl)}`,
        "        models:",
        `          - id: ${JSON.stringify(model)}`,
      ];
  return `${lines.join("\n")}\n`;
}
