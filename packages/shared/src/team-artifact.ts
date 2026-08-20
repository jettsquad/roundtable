/**
 * team-artifact.ts — writing a reply to a file, when the host asked for one.
 *
 * Intent comes from the instruction; execution comes from the program. The
 * host decides whether this round produces a document and where it goes; the
 * app writes the reply verbatim and confirms it landed.
 *
 * Not on every phase boundary. An ordinary host message runs through the
 * same phase machinery as an agenda stage, so "write at the end of a phase"
 * means a file per seat per round — dozens of files of small talk dropped
 * into the user's own project folder. A structural boundary does not carry
 * intent; the instruction does.
 *
 * And not by the agent either. Asking it to write the file costs the four
 * things a program gets for free: a path that cannot collide, proof the
 * write happened, a record of what exists, and text identical to the reply.
 */

/** Where a round's replies should be written, if anywhere. */
export interface ArtifactRequest {
  /** Host-supplied path, relative to the team's project folder. */
  readonly path: string;
}

export interface ArtifactTarget {
  readonly seatId: string;
  readonly phaseId: string;
}

export class ArtifactPathError extends Error {}

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * Normalise a host-supplied path into a project-relative one.
 *
 * The team's working directory is the user's real project folder, so a path
 * that escapes it would let a discussion write anywhere on the machine.
 * Escapes are refused rather than silently rewritten: a host who typed
 * `../../notes.md` meant something, and quietly writing elsewhere would be
 * worse than saying no.
 */
export const normaliseArtifactPath = (raw: string): string => {
  const trimmed = raw.trim().replace(/\\/g, "/");
  if (trimmed === "") throw new ArtifactPathError("文件路径不能为空。");
  if (trimmed.startsWith("/") || WINDOWS_ABSOLUTE.test(trimmed))
    throw new ArtifactPathError(`文件路径必须相对于团队项目文件夹：「${raw}」是绝对路径。`);
  const segments = trimmed.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === ".."))
    throw new ArtifactPathError(`文件路径不能跳出团队项目文件夹：「${raw}」。`);
  if (segments.length === 0) throw new ArtifactPathError("文件路径不能为空。");
  return segments.join("/");
};

/** The path used when the host asked for a document without naming one. */
export const defaultArtifactPath = (target: ArtifactTarget): string => `squad/${target.seatId}-${target.phaseId}.md`;

/**
 * Resolve the path for one seat's reply.
 *
 * When several seats answer the same instruction, one named path would have
 * them overwrite each other and leave only whoever finished last — so the
 * seat id is folded into the file name. With a single seat the host's path
 * is used exactly as given.
 */
export const resolveArtifactPath = (
  request: ArtifactRequest | undefined,
  target: ArtifactTarget,
  seatCount: number,
): string | undefined => {
  if (request === undefined) return undefined;
  const base = request.path.trim() === "" ? defaultArtifactPath(target) : normaliseArtifactPath(request.path);
  if (seatCount <= 1) return base;
  const lastSlash = base.lastIndexOf("/");
  const dir = lastSlash < 0 ? "" : base.slice(0, lastSlash + 1);
  const name = lastSlash < 0 ? base : base.slice(lastSlash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const ext = dot <= 0 ? "" : name.slice(dot);
  return `${dir}${stem}-${target.seatId}${ext}`;
};
