/**
 * local-media.ts — pictures that live in the team's folder, made showable.
 *
 * A pasted screenshot is written to `squad-images/`, and a seat that fetches
 * a file writes it to `squad-downloads/` (see `webAccessNote`). Both are
 * plain files on disk, and a message that mentions one has only its PATH —
 * which a browser cannot open. This rewrites those paths into URLs the panel
 * can load, so a picture shows where it was mentioned instead of as a line of
 * text you will not remember the meaning of.
 *
 * Pure on purpose: the URL comes in as a function, and the server is what
 * decides whether a given path may actually be read.
 */

/** Folders under a team's project folder whose images the panel may show. */
export const IMAGE_DIR = "squad-images";
export const DOWNLOAD_DIR = "squad-downloads";

const DIRS = `squad-(?:images|downloads)`;
const EXT = `(?:png|jpe?g|gif|webp|bmp|svg)`;

/** `![alt](/abs/path/x.png)` — any absolute path; the server decides whether it may be read. */
const MARKDOWN_IMAGE = new RegExp(`!\\[([^\\]]*)\\]\\(((?:/|[a-z]:[\\\\/]|\\\\\\\\)[^)\\s]+\\.${EXT})\\)`, "gi");

function safeDecode(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/**
 * A path written so it survives inside `![](…)`: spaces and brackets would end
 * the link early, and a project folder with a space in it is ordinary.
 */
export function markdownPath(path: string): string {
  const portable = /^(?:[a-z]:[\\/]|\\\\)/i.test(path) ? path.replace(/\\/g, "/") : path;
  return encodeURI(portable).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/**
 * The file a pasted-image material points at, or undefined for any other
 * material. Reads the pointer `imagePointer` wrote, so the two must agree.
 */
export function imagePathOfMaterial(text: string): string | undefined {
  if (!text.includes("这是一张图片")) return undefined;
  const path = /文件在：(.+)/.exec(text)?.[1]?.trim();
  return path !== undefined && new RegExp(`[\\\\/]${DIRS}[\\\\/]`).test(path) ? path : undefined;
}

/** Old Windows messages recorded only attachment names. Recover a preview
 * only when exactly one image with that name existed at send time. */
export function legacyAttachedImages(
  text: string,
  at: number,
  materials: readonly { readonly name: string; readonly addedAt: number; readonly imagePath?: string }[],
): readonly { readonly alt: string; readonly path: string }[] {
  if (extractLocalImages(text).images.length > 0) return [];
  const names = /（本轮附带资料：([^\n]*)）/.exec(text)?.[1]?.split("、") ?? [];
  return names.flatMap((name) => {
    const candidates = materials.filter((material) => material.name === name && material.addedAt <= at);
    const material = candidates.length === 1 ? candidates[0] : undefined;
    return material?.imagePath === undefined ? [] : [{ alt: name, path: material.imagePath }];
  });
}

/**
 * Take the local pictures embedded with `![alt](/abs/x.png)` out of a message.
 *
 * The Markdown renderer this panel uses prints an image as its alt text and
 * nothing else — measured: a screenshot showed up as the italic words
 * "image.png". So embedded pictures are pulled out, in order, and shown by the
 * panel itself; what is left is the text to hand the renderer.
 */
export function extractLocalImages(text: string): {
  readonly text: string;
  readonly images: readonly { readonly alt: string; readonly path: string }[];
} {
  const images: { alt: string; path: string }[] = [];
  const rest = replaceOutsideCode(text, MARKDOWN_IMAGE, (_all, alt: string, path: string) => {
    images.push({ alt, path: safeDecode(path) });
    return "";
  });
  // The gap the removal leaves: a line that held only a picture is now blank.
  return {
    text: rest
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd(),
    images,
  };
}

/** A fenced block or an inline code span: text shown as written, not interpreted. */
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

/**
 * Apply a replacement to the parts of a message that are not code.
 *
 * `![架构草图](/absolute/path/to/arch.png)` inside a code block is a
 * demonstration of the syntax, not a picture. Treated as one it was pulled out
 * of the block — leaving the block empty — and drawn as a broken image for a
 * file that never existed.
 */
function replaceOutsideCode(text: string, pattern: RegExp, replacement: (...groups: string[]) => string): string {
  let out = "";
  let from = 0;
  for (const code of text.matchAll(CODE)) {
    const at = code.index ?? 0;
    out += text.slice(from, at).replace(pattern, replacement as never) + code[0];
    from = at + code[0].length;
  }
  return out + text.slice(from).replace(pattern, replacement as never);
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Image files a message MENTIONS, inside the team's project folder.
 *
 * Found anywhere in the text, code blocks included: an agent that finishes
 * drawing something reports the path in a fenced block so it can be copied,
 * and that is exactly the message where the picture is wanted. The text is
 * left as written and the pictures are shown beneath it — rewriting inside a
 * code block would break the copy button it sits under.
 *
 * Pictures already embedded with `![](…)` are left out; they render in place.
 */
export function imagePathsIn(text: string, projectFolder: string): readonly string[] {
  const root = projectFolder.replace(/[\\/]+$/, "");
  if (root === "") return [];
  const bare = replaceOutsideCode(text, MARKDOWN_IMAGE, () => " ");
  const rootPattern = root.split(/[\\/]/).map(escapeRegExp).join("[\\\\/]");
  const found = new RegExp(`${rootPattern}[\\\\/][^\\s\`"'()<>\\]|]*?\\.${EXT}(?![\\w/\\\\.-])`, "gi");
  return [...new Set(bare.match(found) ?? [])];
}
