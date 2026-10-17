import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bumpedComponents, markupSnippets, releaseNoteMarkup, verifyReleaseData } from "./release-pr-body";

const config = { packages: { ".": { component: "cloud" }, "packages/ui": { component: "npm-ui" } } };
const bumped = [{ path: ".", component: "cloud", version: "1.0.0" }];

describe("bumpedComponents", () => {
  test("includes changed and added paths, excluding unchanged paths", () => {
    expect(bumpedComponents(config, { ".": "0.9.0" }, { ".": "1.0.0", "packages/ui": "2.0.0" })).toEqual([
      ...bumped,
      { path: "packages/ui", component: "npm-ui", version: "2.0.0" },
    ]);
    expect(bumpedComponents(config, { ".": "1.0.0" }, { ".": "1.0.0" })).toEqual([]);
  });

  test("rejects a bumped path with no configured component", () => {
    expect(() => bumpedComponents({ packages: { ".": {} } }, {}, { ".": "1.0.0" })).toThrow(
      "Bumped manifest path . (1.0.0) has no component",
    );
    expect(() => bumpedComponents({ packages: {} }, {}, { ".": "1.0.0" })).toThrow("has no component");
  });
});

describe("verifyReleaseData", () => {
  test("accepts matching releases", () => {
    expect(verifyReleaseData(bumped, [{ component: "cloud", version: "1.0.0", notes: "Changes" }])).toEqual([]);
  });

  test("names a missing component, version, and merge consequence", () => {
    expect(verifyReleaseData(bumped, [])).toEqual(["Missing cloud 1.0.0: release-please will not create that release on merge."]);
  });

  test("reports mismatched or absent versions", () => {
    expect(verifyReleaseData(bumped, [{ component: "cloud", version: "0.9.0", notes: "" }])[0]).toContain(
      "0.9.0 differs from manifest version 1.0.0",
    );
    expect(verifyReleaseData(bumped, [{ component: "cloud", notes: "" }])[0]).toContain("(missing) differs");
  });

  test("finds swallowed sections even when both releases parse", () => {
    const findings = verifyReleaseData(bumped, [
      { component: "cloud", version: "1.0.0", notes: "Changes\nnpm-ui: 2.0.0.\nUI changes" },
      { component: "npm-ui", version: "2.0.0", notes: "UI changes" },
    ]);
    expect(findings).toEqual(["cloud notes contain npm-ui: 2.0.0: swallowed section from npm-ui."]);
  });

  test("finds a bumped section even when that release did not parse", () => {
    expect(verifyReleaseData(bumped, [{ component: "npm-cloud", version: "1.0.0", notes: "cloud: 1.0.0" }])).toContain(
      "npm-cloud notes contain cloud: 1.0.0: swallowed section from cloud.",
    );
  });

  test("does not confuse component suffixes or version prefixes", () => {
    expect(verifyReleaseData(bumped, [{ component: "cloud", version: "1.0.0", notes: "npm-cloud: 1.0.0" }])).toEqual([]);
    expect(
      verifyReleaseData(bumped, [
        { component: "cloud", version: "1.0.0", notes: "" },
        { component: "npm-ui", version: "2.0.0", notes: "npm-cloud: 1.0.0; cloud: 1.0.01" },
      ]),
    ).toEqual([]);
  });
});

describe("markupSnippets", () => {
  test.each(["<dir>", "</x>", "<!-- comment -->", "Result<T>"])("flags %s", (text) => {
    expect(markupSnippets(text)).toEqual([text]);
  });

  test("ignores literal structural tags and harmless less-than signs", () => {
    expect(markupSnippets("<details><summary>cloud: 1.0.0</summary></details> <3 <= <-> a < 5")).toEqual([]);
    expect(markupSnippets('<details class="x">')).toHaveLength(1);
  });

  test("returns a short single-line snippet per occurrence", () => {
    const snippets = markupSnippets(`${"x".repeat(80)}\n<dir>\n${"y".repeat(80)} </x>`);
    expect(snippets).toHaveLength(2);
    expect(snippets.every((snippet) => snippet.length < 50 && !snippet.includes("\n"))).toBe(true);
  });
});

describe("releaseNoteMarkup", () => {
  test("checks the whole title", () => {
    const findings = releaseNoteMarkup("fix(cli): accept <dir>", "");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("in title:");
    expect(findings[0]).toContain("DIR or {dir}");
    expect(findings[0]).toContain("#1298");
  });

  test("rejects structural tags in authored release text", () => {
    expect(releaseNoteMarkup("fix: use <details>", "BREAKING CHANGE: </summary>")).toHaveLength(2);
  });

  test("checks only the BREAKING CHANGE paragraph in the body", () => {
    const findings = releaseNoteMarkup(
      "feat(cli)!: change input",
      "Ordinary <dir>\n\nBREAKING CHANGE: use\n<source> instead.\n\nIgnored <dir>",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("BREAKING CHANGE footer");
    expect(findings[0]).toContain("<source>");
    expect(findings[0]).not.toContain("<dir>");
  });

  test("checks across whitespace-only lines with the hyphen variant, CRLF, and multiple footers", () => {
    expect(
      releaseNoteMarkup("fix: input", "BREAKING-CHANGE: use\r\n<dir>\r\n \t\r\nignored <x>\r\n\r\nBREAKING CHANGE: </x>"),
    ).toHaveLength(3);
  });

  test.each(["\n", "\r\n"])("only a truly empty line ends a footer (%j)", (newline) => {
    const findings = releaseNoteMarkup("feat(x): add y", ["BREAKING CHANGE: migrate", " \t", "Use <dir>", "", "next <a>"].join(newline));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("BREAKING CHANGE footer");
    expect(findings[0]).toContain("<dir>");
    expect(findings[0]).not.toContain("<a>");
  });

  test.each(["Some text\n", "Some text\n\n"])("checks body commit header lines after %j", (prefix) => {
    const findings = releaseNoteMarkup("feat(x): add y", `${prefix}fix(cli): use <dir>`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("commit header line in the body");
    expect(findings[0]).toContain("<dir>");
  });

  test.each(["fix:`<dir>`", "fix:\t<dir>", "Fix: cap <dir>", "FEAT(cli)!: use <dir>"])("checks the header form %j", (line) => {
    expect(releaseNoteMarkup("feat(x): add y", `Intro\n\n${line}`)).toHaveLength(1);
  });

  test.each([
    ["BEGIN_NESTED_COMMIT\nfix(cli): use DIR\nBREAKING CHANGE: ok\n\nmore <dir>\nEND_NESTED_COMMIT", "BEGIN_NESTED_COMMIT block"],
    ["Text BEGIN_NESTED_COMMIT fix: use <dir> END_NESTED_COMMIT more", "BEGIN_NESTED_COMMIT block"],
    ["BEGIN_COMMIT_OVERRIDE\nfeat: use DIR\n\nnotes <dir>\nEND_COMMIT_OVERRIDE", "BEGIN_COMMIT_OVERRIDE block"],
    ["BEGIN_NESTED_COMMIT\nfix: unterminated <dir>", "BEGIN_NESTED_COMMIT block"],
  ])("checks the whole block in %j", (body, where) => {
    const findings = releaseNoteMarkup("feat(x): add y", body);
    expect(findings.some((finding) => finding.includes(where) && finding.includes("<dir>"))).toBe(true);
  });

  test("ignores markup after a block ends", () => {
    expect(releaseNoteMarkup("feat(x): add y", "BEGIN_NESTED_COMMIT\nfix: use DIR\nEND_NESTED_COMMIT\n\nProse <dir>")).toEqual([]);
  });

  test.each(["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"])(
    "checks %s body headers with optional scopes and breaking markers",
    (type) => {
      for (const suffix of ["", "(cli)", "!", "(cli)!"]) {
        expect(releaseNoteMarkup("fix: input", `${type}${suffix}: use <dir>`)).toHaveLength(1);
      }
    },
  );

  test("checks a split commit's header without its ordinary body", () => {
    const findings = releaseNoteMarkup("feat(x): add y", "Some text\n\nfeat(ui): extra <d>\nwith body\n\nend <a>");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("<d>");
    expect(findings[0]).not.toContain("<a>");
  });

  test("allows markup in prose, bullets, and indented headers", () => {
    expect(releaseNoteMarkup("fix: input", "Uses `<Button>`\n- fix: x <c>\n fix: use <dir>\nExample fix: <dir>")).toEqual([]);
  });

  test("requires a line-start token", () => {
    expect(releaseNoteMarkup("fix: input", "Example BREAKING CHANGE: <dir>\n BREAKING CHANGE: <x>")).toEqual([]);
  });

  test("flags the original f951e9674 commit's breaking footer", () => {
    const message = readFileSync(new URL("./fixtures/release-pr-body/1227-commit-message.txt", import.meta.url), "utf8");
    const [title = "", ...body] = message.split("\n");
    const findings = releaseNoteMarkup(title, body.join("\n"));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.includes("BREAKING CHANGE footer"))).toBe(true);
  });

  test("accepts a clean title and body, including ordinary body markup", () => {
    expect(releaseNoteMarkup("fix(cli): accept DIR", "Use <dir> here.\n\nBREAKING CHANGE: use {dir}.\n\nOutside <source>")).toEqual([]);
  });
});
