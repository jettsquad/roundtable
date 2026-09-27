import { describe, expect, it } from "vitest";
import { extractLocalImages, imagePathOfMaterial, imagePathsIn } from "../src/local-media.ts";
import { attachmentNote } from "../src/material.ts";

describe("extractLocalImages", () => {
  it("pulls embedded local pictures out and leaves the text", () => {
    const out = extractLocalImages("你看得到吗？（本轮附带资料：image.png）\n![image.png](/p/My%20Files/a%20b.png)");
    expect(out.text).toBe("你看得到吗？（本轮附带资料：image.png）");
    expect(out.images).toEqual([{ alt: "image.png", path: "/p/My Files/a b.png" }]);
  });
  it("leaves remote images and non-image links in the text", () => {
    const text = "![a](https://x.io/a.png) ![b](/p/a.pdf)";
    expect(extractLocalImages(text)).toEqual({ text, images: [] });
  });
});

describe("imagePathsIn", () => {
  const folder = "/Volumes/Jett/projects/claude_hiking_hub_app";
  it("finds the drawings an agent reports inside code blocks", () => {
    const text = [
      "SVG（矢量源文件）：",
      "```",
      `${folder}/docs/schematics/integrated-navigation-schematic.svg`,
      "```",
      `PNG：\`${folder}/docs/schematics/integrated-navigation-schematic.png\``,
    ].join("\n");
    expect(imagePathsIn(text, folder)).toEqual([
      `${folder}/docs/schematics/integrated-navigation-schematic.svg`,
      `${folder}/docs/schematics/integrated-navigation-schematic.png`,
    ]);
  });
  it("lists a path once, and ignores other folders, non-images and embedded pictures", () => {
    const text = `${folder}/a.png ${folder}/a.png /etc/b.png ${folder}/c.pdf ![x](${folder}/d.png)`;
    expect(imagePathsIn(text, folder)).toEqual([`${folder}/a.png`]);
  });
  it("copes with a folder that has spaces and regex characters", () => {
    const odd = "/My Files/proj (1)";
    expect(imagePathsIn(`见 ${odd}/out/a b.png`, odd)).toEqual([]);
    expect(imagePathsIn(`见 ${odd}/out/ab.png。`, odd)).toEqual([`${odd}/out/ab.png`]);
  });
});

describe("pasted image in a round's note", () => {
  const pointer = (path: string): string =>
    `（这是一张图片，不是文字。文件在：${path}\n用你的读文件工具打开它再回答。）`;
  it("finds the file a pasted-image material points at, and nothing else", () => {
    expect(imagePathOfMaterial(pointer("/p/squad-images/a.png"))).toBe("/p/squad-images/a.png");
    expect(imagePathOfMaterial("普通文档，文件在：/p/squad-images/a.png")).toBeUndefined();
    expect(imagePathOfMaterial(pointer("/etc/a.png"))).toBeUndefined();
  });
  it("survives a folder name with spaces and brackets, all the way to the URL", () => {
    const path = "/My Files/proj (1)/squad-images/a b.png";
    const note = attachmentNote([{ materialId: "m", name: "image.png", text: pointer(path), addedAt: 0 }]) ?? "";
    expect(note).toContain("（本轮附带资料：image.png）");
    expect(extractLocalImages(note).images).toEqual([{ alt: "image.png", path }]);
  });
});
