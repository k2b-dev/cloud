import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { collisionsIn, rule } from "./scoped-variants";

const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-scoped-variants-"));
  try {
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

/** The colliding pairs in one class list, as `plain|variant`. */
const pairs = async (classes: string) =>
  (await collisionsIn("/fixture.ts", `export const classes = ${JSON.stringify(classes)};`)).map(
    ({ plain, variant }) => `${plain}|${variant}`,
  );

test("reports a plain display next to a breakpoint display in shared UI (UI-28)", async () => {
  expect(
    await findings({
      "packages/cloud/src/Row.tsx": [
        "export const Row = (props: { wide: boolean }) => (",
        '  <span class="contents max-sm:hidden">',
        '    <span class="max-sm:hidden sm:contents" />',
        '    <span class={props.wide ? "grid gap-2 sm:flex" : "flex"} />',
        '    <span class={`hidden ${props.wide ? "a" : "b"} @md:block`} />',
        // Passed under breakpoint-display; `dark:` is as order-dependent as a breakpoint, so it reports now.
        '    <span class="flex items-center md:gap-2 group-hover:hidden dark:hidden" />',
        "  </span>",
        ");",
      ].join("\n"),
      "packages/ui/src/bar.ts": 'export const bar = "hidden lg:flex";\n',
      "packages/ui/src/bar.test.ts": 'export const fixture = "hidden lg:flex";\n',
      "packages/cloud/src/Row.browser-harness.tsx": 'export const harness = "hidden lg:flex";\n',
      "packages/mail/src/App.tsx": 'export const App = () => <div class="hidden md:flex" />;\n',
    }),
  ).toEqual([
    "packages/cloud/src/Row.tsx:2",
    "packages/cloud/src/Row.tsx:4",
    "packages/cloud/src/Row.tsx:5",
    "packages/cloud/src/Row.tsx:6",
    "packages/ui/src/bar.ts:1",
  ]);
});

test("reports every property a breakpoint, container or dark variant shares with a plain utility", async () => {
  expect(await pairs("flex gap-1 sm:gap-2")).toEqual(["gap-1|sm:gap-2"]);
  expect(await pairs("px-2 py-1.5 md:px-3 md:py-2")).toEqual(["px-2|md:px-3", "py-1.5|md:py-2"]);
  expect(await pairs("text-zinc-400 dark:text-zinc-600")).toEqual(["text-zinc-400|dark:text-zinc-600"]);
  expect(await pairs("gap-2 @md:gap-4")).toEqual(["gap-2|@md:gap-4"]);
  // A shorthand and its longhand: an app's `p-2` also resets the padding `md:px-3` sets.
  expect(await pairs("p-2 md:px-3")).toEqual(["p-2|md:px-3"]);
  expect(await pairs("transition motion-safe:transition-transform")).toEqual(["transition|motion-safe:transition-transform"]);
});

test("passes scoped pairs and variants that win or style another element", async () => {
  expect(await pairs("max-sm:gap-1 sm:gap-2 not-dark:text-zinc-400 dark:text-zinc-600")).toEqual([]);
  // More specific than one class: the app's plain utility cannot cancel them.
  expect(await pairs("bg-white hover:bg-zinc-100 data-[open]:bg-zinc-200 light:bg-white aria-selected:bg-zinc-50")).toEqual([]);
  // Children of the element, not the element.
  expect(await pairs("gap-1 [&>svg]:gap-2 *:gap-3")).toEqual([]);
  // Different properties, and an important class that the stylesheet order does not decide.
  expect(await pairs("border dark:border-zinc-700 !p-2 md:p-3 text-sm md:text-zinc-500")).toEqual([]);
  // Not a Tailwind class.
  expect(await pairs("k2b-row sm:k2b-row-wide")).toEqual([]);
});

test("reads the class attributes of HTML in a string", async () => {
  const html = '<pre class="bg-gray-50 dark:bg-gray-900 rounded-md" data-x="p-2 md:p-3">';
  expect(await pairs(html)).toEqual(["bg-gray-50|dark:bg-gray-900"]);
});
