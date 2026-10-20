import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initialProjectMemory } from "@squad/shared";

/** Initialize only the team's own file without asking a model to explore for background. */
export async function ensureProjectMemoryFile(
  folder: string,
  file: string,
): Promise<{ text: string; created: boolean }> {
  const path = join(folder, file);
  try {
    return { text: await readFile(path, "utf8"), created: false };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const text = initialProjectMemory(folder);
  try {
    await writeFile(path, text, { encoding: "utf8", flag: "wx" });
    return { text, created: true };
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    return { text: await readFile(path, "utf8"), created: false };
  }
}
