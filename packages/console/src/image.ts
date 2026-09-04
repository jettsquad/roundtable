/**
 * image.ts — a pasted image becomes a file the seats can open.
 *
 * Not a document: there is no text to extract, so it does not go through
 * `extractDocument`. What travels to a seat is a PATH, and the seat opens it
 * with the file tool it already has — every backend runs with the team's
 * folder as its cwd, so the file is simply there.
 *
 * The alternative was to send a real image block: dsh's subagent seam accepts
 * one (`ContentBlock` has an `image` member), but a provider that cannot take
 * it REFUSES the request — `subagent/attachment-invalid` — and that seat then
 * has no answer at all for the round. A path costs nothing to a seat that
 * cannot read images: it answers the text and says so.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

/** Where pasted images live, under the team's own project folder. */
export const IMAGE_DIR = "squad-images";

/**
 * Extensions treated as images.
 *
 * By extension rather than by sniffing magic bytes: the name is what the
 * seat's file tool will use to decide how to open it, so agreeing with the
 * name is what keeps the two ends consistent.
 */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

export function looksLikeImage(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(name).toLowerCase());
}

/**
 * A name that cannot escape the folder or collide with what is already there.
 *
 * The clipboard hands over `image.png` every single time, so a timestamp is
 * not decoration — without it the second screenshot silently replaces the
 * first, and a material still pointing at the old one now shows the new.
 */
export function imageFileName(name: string, now = Date.now()): string {
  const ext = extname(name).toLowerCase() || ".png";
  const stem = name
    .slice(0, name.length - extname(name).length)
    .replace(/[/\\:*?"<>|\s]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 40);
  return `${now.toString(36)}-${stem === "" ? "image" : stem}${ext}`;
}

/**
 * What a seat reads instead of the picture.
 *
 * The last sentence is the one that matters. A seat told about a file it
 * cannot open will otherwise describe it anyway — this project has already
 * watched that happen with documents, where seats reported on files they had
 * never found. Saying "say so" costs one line and removes the whole failure.
 */
export function imagePointer(path: string): string {
  return [
    `（这是一张图片，不是文字。文件在：${path}`,
    `用你的读文件工具打开它再回答。`,
    `如果你打不开它，或者你读不了图片，就直说——不要猜它的内容。）`,
  ].join("\n");
}

/** Write the bytes into the team's image folder. Returns the absolute path. */
export async function saveImage(projectFolder: string, name: string, bytes: Uint8Array): Promise<string> {
  const dir = join(projectFolder, IMAGE_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, imageFileName(name));
  await writeFile(path, bytes);
  return path;
}
