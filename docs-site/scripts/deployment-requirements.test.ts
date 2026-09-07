import { describe, expect, test } from "bun:test";

const root = new URL("../../", import.meta.url);
const requirements = await Bun.file(new URL("docs-site/docs/en/operations/deployment-requirements.md", root)).text();
const appIds = [...requirements.matchAll(/^\|[^\n]*?\(`([a-z0-9-]+)`\) \|/gm)].map((match) => match[1]!);

const composeAppIds = async (file: string): Promise<string[]> => {
  const source = await Bun.file(new URL(file, root)).text();
  return [...source.matchAll(/^  (gateway|app-[a-z0-9-]+):$/gm)].map((match) => match[1]!.replace(/^app-/, "")).sort();
};

describe("deployment requirements coverage", () => {
  test("documents every development service exactly once and covers production", async () => {
    expect(new Set(appIds).size).toBe(appIds.length);
    expect([...appIds].sort()).toEqual(await composeAppIds("compose.dev.yml"));
    for (const appId of await composeAppIds("compose.prod.yml")) expect(appIds).toContain(appId);
  });

  test("every application catalog page can reach the canonical requirements", async () => {
    const catalog = new URL("docs-site/apps-content/en/", root);
    const pages: string[] = [];
    for await (const filename of new Bun.Glob("*.md").scan(catalog.pathname)) {
      if (filename === "index.md") continue;
      pages.push(filename.replace(/\.md$/, ""));
      const source = await Bun.file(new URL(filename, catalog)).text();
      expect(source).toContain("(/en/docs/operations/deployment-requirements)");
    }
    expect(pages.sort()).toEqual(appIds.filter((id) => id !== "gateway").sort());
  });
});
