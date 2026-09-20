import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { defineHelp } from "./help";

const repoRoot = resolve(import.meta.dir, "../../../..");
// Capabilities and OAuth intentionally own no Help. Quotes is API-only and has no SSR Help surface.
const registeredHelpExemptions = new Set(["capabilities", "oauth", "quotes"]);
const helpPackages = [
  "accounts",
  "api-docs",
  "assistant",
  "contacts",
  "core",
  "dashboard",
  "faq",
  "files",
  "filesv2",
  "gateway-ops",
  "grids",
  "ipa-hosts",
  "mail",
  "notebooks",
  "proxy-auth",
  "pulse",
  "spaces",
  "tools",
  "venue",
  "weather",
] as const;

const sourceGlob = new Bun.Glob("src/help/documents/**/*.help.md");
const withoutFencedCode = (source: string) =>
  source
    .split("\n")
    .reduce<{ fenced: boolean; lines: string[] }>(
      (state, line) => {
        if (/^\s*(```|~~~)/.test(line)) {
          state.fenced = !state.fenced;
          return state;
        }
        if (!state.fenced) state.lines.push(line);
        return state;
      },
      { fenced: false, lines: [] },
    )
    .lines.join("\n");

const readPackageSources = async (packageName: string) => {
  const packageRoot = join(repoRoot, "packages", packageName);
  const sources: Array<{ path: string; source: string }> = [];
  for await (const path of sourceGlob.scan({ cwd: packageRoot })) {
    sources.push({ path: join("packages", packageName, path), source: await Bun.file(join(packageRoot, path)).text() });
  }
  return sources.sort((left, right) => left.path.localeCompare(right.path));
};

describe("Cloud guided Help corpus", () => {
  test("covers every registered app that owns a user-facing UI", async () => {
    const registeredPackages: string[] = [];
    for await (const path of new Bun.Glob("packages/*/src/config.ts").scan({ cwd: repoRoot })) {
      const source = await Bun.file(join(repoRoot, path)).text();
      if (!source.includes("defineApp(")) continue;
      const packageName = path.split("/")[1];
      if (packageName) registeredPackages.push(packageName);
    }

    const covered = new Set(helpPackages);
    const uncovered = registeredPackages.filter((packageName) => !covered.has(packageName as (typeof helpPackages)[number])).sort();
    expect(uncovered).toEqual([...registeredHelpExemptions].sort());
  });

  for (const packageName of helpPackages) {
    test(`${packageName} articles render through the shared guided profile`, async () => {
      const sources = await readPackageSources(packageName);
      expect(sources.length, `${packageName} should own Help Markdown`).toBeGreaterThan(0);

      for (const { path, source } of sources) {
        const collection = defineHelp({ documents: [source] });
        const [document] = collection.documents;
        expect(document, `${path} should define one valid document`).toBeDefined();

        expect(document!.html, `${path} should not leak a guided directive`).not.toMatch(/<p>:::(?:steps|compare|reference)/);
        expect(document!.html, `${path} should not leak heading metadata`).not.toContain('{icon="');

        const headings = [...withoutFencedCode(source).matchAll(/^## (?!#)(.+)$/gm)];
        expect(headings.length, `${path} should have at least one navigable H2 section`).toBeGreaterThan(0);
        expect(
          headings.every((match) => /\{icon="[a-z0-9-]+"\}\s*$/i.test(match[1]!)),
          `${path} should annotate every H2 section`,
        ).toBe(true);

        const ids = [...document!.html.matchAll(/<h2 id="([^"]+)"/g)].map((match) => match[1]);
        expect(new Set(ids).size, `${path} should not render duplicate H2 ids`).toBe(ids.length);
      }
    });
  }

  test("keeps the complete article corpus", async () => {
    const sources = await Promise.all(helpPackages.map(readPackageSources));
    expect(sources.flat().length).toBeGreaterThan(70);
  });
});
