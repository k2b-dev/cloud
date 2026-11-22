import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  bumpedComponents,
  hasCommitOverride,
  markupSnippets,
  releaseNoteMarkup,
  squashBody,
  squashCommitFindings,
  squashMessage,
  verifyReleaseData,
} from "./release-pr-body";

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

  test.each(["security!: use <dir>", "x-y(z)!: use <dir>", "- BREAKING-CHANGE: use <dir>", "Text BREAKING-CHANGE: use <dir>"])(
    "checks the breaking form %j",
    (line) => {
      expect(releaseNoteMarkup("feat(x): add y", `Intro.\n\n${line}`)).toHaveLength(1);
    },
  );

  test("ignores custom types without a breaking marker and indented space-form notes, which release notes leave out", () => {
    expect(releaseNoteMarkup("feat(x): add y", "Note: see <x>\n\n- BREAKING CHANGE: use <dir>\n\n  BREAKING CHANGE: <i>")).toEqual([]);
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

describe("squashMessage", () => {
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/release-pr-body/${name}`, import.meta.url), "utf8");

  test("reproduces the squash commit of #3998 on main from its pull request body", () => {
    const title = "fix(chat): a message sent right after Quote carries its quote instead of leaving it in the field";
    expect(squashMessage(title, "3998", fixture("3998-pr-body.md"))).toBe(fixture("3998-squash-message.txt").trimEnd());
  });

  test("wraps a long line greedily at 72 columns and keeps shorter lines", () => {
    const line = `${"word ".repeat(14)}call(x) and more`;
    expect(squashBody(`short line\n${line}`)).toBe(`short line\n${"word ".repeat(14)}\ncall(x) and more`.replace(" \n", "\n"));
    expect(squashBody("a".repeat(72))).toBe("a".repeat(72));
  });

  test("drops indentation and repeated spaces only of wrapped lines", () => {
    const item = `   - ${"item ".repeat(15).trim()}`;
    expect(squashBody(item)).toBe(`- ${"item ".repeat(14).trim()}\nitem`);
    expect(squashBody("   - short  item")).toBe("   - short  item");
  });

  test("moves a word longer than 72 columns at a line start after an empty line", () => {
    const path = `docs-site/${"x".repeat(70)}.md`;
    expect(squashBody(path)).toBe(`\n${path}`);
    expect(squashBody(`Lesson: ${path}`)).toBe(`Lesson:\n${path}`);
  });

  test("leaves fenced code blocks unwrapped", () => {
    const code = `const value = ${"x".repeat(80)};`;
    expect(squashBody(`\`\`\`ts\n${code}\n\`\`\`\n${"word ".repeat(16).trim()}`)).toBe(
      `\`\`\`ts\n${code}\n\`\`\`\n${"word ".repeat(14).trim()}\nword word`,
    );
  });

  test("normalizes CRLF line ends and writes a title without body alone", () => {
    expect(squashMessage("fix: a", "1", "one\r\ntwo\r\n")).toBe("fix: a (#1)\n\none\ntwo");
    expect(squashMessage("fix: a", "1", "")).toBe("fix: a (#1)");
  });
});

describe("squashCommitFindings", () => {
  const header = "fix(chat): keep the quote (#3998)";
  const entry = (text: string, visible = true, breaking = false) => ({ header: text, visible, breaking });

  test("accepts the title's entry and hidden extra entries", () => {
    expect(squashCommitFindings(header, "Body", [entry(header)], ["some debug line"])).toEqual([]);
    expect(squashCommitFindings(header, "Body", [entry("docs: n/a", false), entry(header), entry("https: //x", false)], [])).toEqual([]);
  });

  test("rejects a dropped commit and a missing title entry", () => {
    const dropped = squashCommitFindings(
      header,
      "Body",
      [],
      [
        "commit could not be parsed: 0 fix(chat): keep the quote (#3998)",
        "error message: Error: unexpected token '(' at 15:17, valid tokens [)]",
      ],
    );
    expect(dropped).toHaveLength(3);
    expect(dropped[1]).toContain("unexpected token '(' at 15:17");
    expect(dropped[2]).toContain("it reads no entry");
  });

  test("rejects an extra entry that reaches the changelog or the version", () => {
    expect(squashCommitFindings(header, "Body", [entry(header), entry("fix: typo")], [])).toEqual([
      'The squash commit yields an extra changelog entry "fix: typo"; put intended extra entries in a BEGIN_COMMIT_OVERRIDE block.',
    ]);
    expect(squashCommitFindings(header, "Body", [entry(header), entry("chore!: drop", false, true)], [])[0]).toContain(
      "extra breaking entry",
    );
  });

  test("with an override, accepts any parsed entries and rejects none", () => {
    const body = "Body\n\nBEGIN_COMMIT_OVERRIDE\nfix(chat): keep the quote\nEND_COMMIT_OVERRIDE";
    expect(hasCommitOverride(body)).toBe(true);
    expect(hasCommitOverride("BEGIN_COMMIT_OVERRIDE\n \nEND_COMMIT_OVERRIDE")).toBe(false);
    expect(squashCommitFindings(header, body, [entry("fix(chat): keep the quote"), entry("feat: more")], [])).toEqual([]);
    expect(squashCommitFindings(header, body, [], [])).toEqual(["The BEGIN_COMMIT_OVERRIDE block yields no release-please entry."]);
  });
});
