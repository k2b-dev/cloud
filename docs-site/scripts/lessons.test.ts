import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFibelApp, defaultPlugins } from "@k2b/fibel";
import { lessonsPlugin } from "../plugins/lessons";
import { renderLessons } from "../src/docs/lessons";
import { checkDocumentation } from "./check-documentation";
import { withoutFencedCode } from "./markdown";

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

const template = `---
title: Lessons learned
navTitle: Lessons learned
section: Contributing
order: 1305
description: Lessons from fixes.
tags: [contributing]
updated: 2026-10-24
---

# Lessons learned

## Add a lesson

~~~markdown
### Example only
~~~

## Error classes

<!-- lesson-classes -->

## Lessons

<!-- lesson-entries -->
`;
const lesson = (title: string) => `### ${title}

- **What happened:** A failure.
- **Root cause:** A confirmed cause.
- **Error class:** An independently useful class.
- **Guard:** A regression test.
`;

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-lessons-"));
  temporary.push(root);
  const docsRoot = join(root, "docs/en");
  const entries = join(docsRoot, "contributing/lessons");
  await mkdir(entries, { recursive: true });
  await writeFile(join(docsRoot, "contributing/lessons-learned.md"), template);
  return { root, docsRoot, entries };
};

test("orders dates descending, same-day names ascending, and undated lessons last", () => {
  const result = renderLessons(template, [
    { path: "legacy/old.md", body: lesson("Undated") },
    { path: "2026-10-23-b.md", body: lesson("Earlier") },
    { path: "2026-10-24-b.md", body: lesson("Same day second") },
    { path: "2026-10-24-a.md", body: lesson("Latest") },
  ]);
  expect([...withoutFencedCode(result).matchAll(/^### (.+)$/gm)].map((match) => match[1])).toEqual([
    "Latest",
    "Same day second",
    "Earlier",
    "Undated",
  ]);
  expect(result).toContain("| An independently useful class. | A failure. | A regression test. |");
});

test("rejects inline additions, missing markers, malformed names and missing guards", () => {
  const inline = ["| A | B | C |", lesson("Inline")];
  for (const extra of inline) expect(() => renderLessons(`${template}\n${extra}`, [])).toThrow("Move inline lessons");
  expect(() => renderLessons(template.replace("<!-- lesson-entries -->", ""), [])).toThrow("exactly one");
  for (const path of ["undated.md", "2026-02-30-bad.md", "2026-10-24/nested.md"]) {
    expect(() => renderLessons(template, [{ path, body: lesson("Malformed") }])).toThrow("valid date");
  }
  expect(() =>
    renderLessons(template, [{ path: "2026-10-24-missing.md", body: lesson("No guard").replace(/- \*\*Guard:.+/, "") }]),
  ).toThrow("missing Guard");
});

test("frontmatter is rejected consistently and fenced examples do not become headings or fields", () => {
  expect(() =>
    renderLessons(template, [{ path: "2026-10-24-frontmatter.md", body: `---\ntitle: Hidden\n---\n${lesson("Frontmatter")}` }]),
  ).toThrow("must not have frontmatter");
  const example = "\n~~~sh\n# Shell comment\n- **Guard:** This is just an example.\n~~~\n";
  expect(renderLessons(template, [{ path: "2026-10-24-example.md", body: lesson("Example") + example }])).toContain("# Shell comment");
  expect(() =>
    renderLessons(template, [{ path: "2026-10-24-example.md", body: lesson("Example").replace(/- \*\*Guard:.+/, "") + example }]),
  ).toThrow("missing Guard");
});

test("independent Git additions merge cleanly and reach every Fibel content surface", async () => {
  const { root, entries, docsRoot } = await fixture();
  const git = async (...args: string[]) => {
    const result =
      await Bun.$`git -C ${root} -c user.name=Fixture -c user.email=fixture@example.com -c commit.gpgsign=false ${args}`.quiet();
    return result.stdout.toString().trim();
  };
  await git("init", "-b", "main");
  await git("add", ".");
  await git("commit", "-m", "Initial source page");
  await git("checkout", "-b", "fix/first");
  await writeFile(join(entries, "2026-10-23-first.md"), lesson("First independent fix"));
  await git("add", ".");
  await git("commit", "-m", "First lesson");
  await git("checkout", "-b", "fix/second", "main");
  // Git removes the first branch's directory: empty directories are not tracked.
  await mkdir(entries, { recursive: true });
  await writeFile(join(entries, "2026-10-24-second.md"), lesson("Second independent fix"));
  await git("add", ".");
  await git("commit", "-m", "Second lesson");
  await git("merge", "--no-edit", "fix/first");
  expect(await git("diff", "main", "--", "docs/en/contributing/lessons-learned.md")).toBe("");

  const app = await createFibelApp({
    root,
    title: "Fixture",
    description: "Lesson fixture.",
    collections: [{ id: "docs", label: "Docs", content: "docs", path: "/docs" }],
    defaultCollection: "docs",
    locales: [{ code: "en", label: "English" }],
    plugins: [...defaultPlugins(), lessonsPlugin()],
  });
  expect(app.context.pages).toHaveLength(1);
  const overview = app.context.pages[0];
  for (const content of [overview.body, overview.raw, overview.html]) {
    expect(content).toContain("First independent fix");
    expect(content).toContain("Second independent fix");
    expect(content).not.toContain("<!-- lesson-entries -->");
  }
  expect(overview.headings.map((heading) => heading.id)).toContain("second-independent-fix");
  expect(overview.headings.map((heading) => heading.id)).not.toContain("example-only");
  expect(app.context.searchIndex.some((entry) => entry.text.includes("First independent fix"))).toBe(true);
  expect(app.context.searchIndex.some((entry) => entry.text.includes("Second independent fix"))).toBe(true);
  const markdown = await app.fetch(new Request("http://fixture/en/docs/contributing/lessons-learned.md"));
  expect(markdown.status).toBe(200);
  expect(await markdown.text()).toContain("First independent fix");
  const full = await app.fetch(new Request("http://fixture/en/docs/llms-full.txt"));
  expect(await full.text()).toContain("Second independent fix");
  // The validator requires the complete convention catalog even for a partial check.
  const conventions = join(docsRoot, "conventions");
  await cp(join(import.meta.dir, "../docs/en/conventions"), conventions, { recursive: true });
  const conventionCount = Array.from(new Bun.Glob("**/*.md").scanSync({ cwd: conventions })).length;
  const checked = await checkDocumentation({ docsRoot, requestedPaths: [join(entries, "2026-10-24-second.md")] });
  expect(checked.errors).toEqual([]);
  expect(checked.checked).toBe(1);
  expect(checked.indexed).toBe(1 + conventionCount);

  await writeFile(
    join(entries, "2026-10-24-second.md"),
    lesson("Second independent fix").replace("A failure.", "[Broken](/en/docs/missing)"),
  );
  const broken = await checkDocumentation({ docsRoot, requestedPaths: [join(entries, "2026-10-24-second.md")] });
  expect(broken.errors.some((error) => error.includes("broken documentation link"))).toBe(true);
});
