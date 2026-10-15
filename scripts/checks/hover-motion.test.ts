import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./hover-motion";

test("rejects hover and focus motion and hover shadows across package sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-hover-motion-rule-"));
  try {
    const files = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/demo", "packages/ui"] } }),
      "packages/demo/src/page.tsx": [
        '<div class="group-hover:translate-x-0.5" />',
        '<div class="hover:-translate-y-1" />',
        '<div class="hover:scale-105" />',
        '<div class="md:hover:shadow-sm" />',
        '<div class="group-hover/card:shadow-xs" />',
        '<div class="focus-visible:scale-95" />',
        '<div class="hover:drop-shadow-md" />',
        '<div class="hover:!shadow" />',
        '<div class="peer-focus-within/item:!-rotate-3" />',
        '<div class="md:group-hover/card:-translate-x-0.5" />',
        '<div class="hover:shadow-[0_1px_2px_red]" />',
      ].join("\n"),
      "packages/ui/src/classes.ts": 'const classes = `hover:scale-x-105`;\nconst conditional = ok ? "peer-hover/quick:rotate-3" : "";',
      "packages/demo/src/valid.tsx":
        '<main class="hover:bg-zinc-100 hover:shadow-none focus-visible:shadow-[var(--ui-focus)] hover:shadow-[inset_0_0_0_1px_red] active:scale-95 translate-x-1 -translate-x-1/2 group-hover:opacity-100 hover:shadow-blue-500 hover:drop-shadow-none shadow-xs transition-[opacity,transform] hover:shadow-inner focus:shadow-lg" />',
      "packages/demo/src/app.css": [
        ".a:hover { transform: translateY(0); }",
        ".b:hover { box-shadow: 0 1px 2px red; }",
        "@utility x { color: red; &:hover { scale: 1.02; } }",
        ".c:focus-visible { transform: scale(1.1); }",
        "@media (any-hover: hover) { .d:hover .e { translate: 0 2px; } }",
        ".f { @apply hover:translate-x-1; }",
        ".g:not(:hover) { transform: translateY(2px); }",
        ".h:hover { box-shadow: none; }",
        ".i:hover { box-shadow: inset 0 0 0 1px red, inset 0 1px 0 white; }",
        ".j:hover { box-shadow: var(--ui-shadow-surface); }",
        ".k:focus-visible { box-shadow: 0 0 0 3px blue; }",
        ".l:hover { transform: none; }",
        ".m { transform: translateX(-50%); }",
        ".n:hover { background: red; }",
        "/* .comment:hover { transform: scale(2); }",
        ".comment { @apply hover:scale-150; } */",
        ".o:is(:hover) {",
        "  color: red;",
        "  rotate: 3deg !important;",
        "  scale: 1.02;",
        "}",
        ".p:has(:focus-within) { translate: 1px; }",
        ".q:hover { box-shadow: inset 0 0 1px rgb(0, 0, 0), var(--ring, rgb(0, 0, 0)); }",
        ".r:hover { box-shadow: inset 0 0 1px rgb(0, 0, 0), 0 1px 2px rgb(0, 0, 0); }",
        ".s:hover { transform: none !important; rotate: none; scale: none; translate: none; }",
        "@utility x { transform: scale(2); }",
      ].join("\n"),
      "packages/demo/src/selectors.css": ".card:hover:scale-105 { color: red; }",
      "packages/demo/src/boundaries.ts":
        'const text = "xhover:scale-105 -hover:scale-105 :hover:scale-105 /hover:scale-105 [hover:scale-105 .hover:scale-105";',
      "packages/demo/src/page.test.tsx": '<div class="hover:scale-105" />',
      "packages/demo/src/page.spec.tsx": '<div class="hover:scale-105" />',
      "packages/demo/test/page.tsx": '<div class="hover:scale-105" />',
      "packages/other/src/page.tsx": '<div class="hover:scale-105" />',
    };
    for (const [path, source] of Object.entries(files)) {
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, source);
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map(({ file, line }) => `${file ? relative(root, file) : ""}:${line}`).sort()).toEqual(
      [
        ...[1, 2, 3, 4, 5, 6, 7, 19, 20, 22, 24].map((line) => `packages/demo/src/app.css:${line}`),
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((line) => `packages/demo/src/page.tsx:${line}`),
        "packages/ui/src/classes.ts:1",
        "packages/ui/src/classes.ts:2",
      ].sort(),
    );
    expect(findings.every(({ message }) => /changes? only paint/.test(message))).toBe(true);
    expect(findings.find(({ message }) => message.startsWith("group-hover:translate-x-0.5"))?.message).toBe(
      "group-hover:translate-x-0.5 moves the element under the pointer; hover and focus change only paint, such as color or opacity.",
    );
    expect(findings.find(({ message }) => message.startsWith("hover:!shadow"))?.message).toBe(
      "hover:!shadow lifts the element on hover; hover changes only paint, such as color.",
    );
    expect(findings.find(({ message }) => message.startsWith(".a:hover"))?.message).toBe(
      ".a:hover sets transform: translateY(0); hover and focus change only paint, such as color or opacity.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
