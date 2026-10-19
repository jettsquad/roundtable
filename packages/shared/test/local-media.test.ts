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

describe("代码里的图片语法是示范，不是图片", () => {
  const demo = "我会这样写：\n\n```\n![架构草图](/absolute/path/to/arch.png)\n```\n\n你直接看到。";

  it("围栏里的 ![](…) 原样留着，不抽走、不当成图", () => {
    // 野间解释「怎么给你看图」时举的例子：以前被抽走，围栏里空了一块，
    // 底下还出现一张加载不出来的破图。
    const out = extractLocalImages(demo);
    expect(out.images).toEqual([]);
    expect(out.text).toContain("![架构草图](/absolute/path/to/arch.png)");
  });

  it("行内代码里的也一样", () => {
    const out = extractLocalImages("语法是 `![说明](/a/b.png)`，别当真。");
    expect(out.images).toEqual([]);
    expect(out.text).toContain("`![说明](/a/b.png)`");
  });

  it("代码外面的真图片照旧抽出来", () => {
    const out = extractLocalImages("看这个：\n\n![图](/Users/x/p/squad-images/a.png)\n\n```\n![例](/x/y.png)\n```");
    expect(out.images).toEqual([{ alt: "图", path: "/Users/x/p/squad-images/a.png" }]);
    expect(out.text).toContain("![例](/x/y.png)");
  });

  it("没写完的围栏，后面都算代码", () => {
    expect(extractLocalImages("```\n![例](/x/y.png)").images).toEqual([]);
  });

  it("代码块里报告的项目内图片路径，仍然会被找出来显示", () => {
    const root = "/Volumes/Jett/p";
    const text = "画好了：\n\n```\n![图](/Volumes/Jett/p/squad-downloads/a.png)\n```";
    expect(imagePathsIn(text, root)).toEqual(["/Volumes/Jett/p/squad-downloads/a.png"]);
  });
});
