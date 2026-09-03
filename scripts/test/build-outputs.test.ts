/**
 * The two browser bundles must not share an output path.
 *
 * They differ only in the id they register under — `@squad/console` for the
 * development profile's row, `@jettsquad/roundtable` for the published
 * package — so one output path means whichever build ran last wins. The loser
 * is a RUNNING interface: the next page load fails with
 * `failed to import loader entry (@squad/console)`, an error that names
 * neither build and points at neither script.
 *
 * That happened. This test is the thing that would have caught it, so it
 * asserts the shape rather than the behaviour: the published call must pass an
 * explicit `outfile`, and that path must not be the development default.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scripts = dirname(dirname(fileURLToPath(import.meta.url)));

describe("浏览器产物的输出路径", () => {
  it("发布态的构建显式指定 outfile", async () => {
    const source = await readFile(join(scripts, "build-bundle.mjs"), "utf8");
    const call = /buildClient\((.*?)\);/s.exec(source);
    expect(call, "build-bundle.mjs 里找不到 buildClient 调用").not.toBeNull();
    expect(call?.[1]).toContain("outfile");
  });

  it("发布态写进 bundle/lib，不写开发态那份", async () => {
    const source = await readFile(join(scripts, "build-bundle.mjs"), "utf8");
    expect(source).toContain('outfile: join(outDir, "client.js")');
    // The development artifact's path must not appear as a write target here.
    expect(source).not.toMatch(/outfile:[^\n]*packages\/console\/client/);
  });

  it("开发态的默认输出仍然是工作区包自己的 client/", async () => {
    const source = await readFile(join(scripts, "build-client.mjs"), "utf8");
    expect(source).toMatch(/outfile = join\(root, "packages", pkg, "client\/client\.js"\)/);
  });

  it("两个注册 id 不同——同名就没有这个问题，也就不需要两个路径", async () => {
    const client = await readFile(join(scripts, "build-client.mjs"), "utf8");
    const bundle = await readFile(join(scripts, "build-bundle.mjs"), "utf8");
    expect(client).toContain("id = `@squad/${pkg}`");
    expect(bundle).toContain("id: PACKAGE");
    expect(bundle).toContain('const PACKAGE = "@jettsquad/roundtable"');
  });
});
