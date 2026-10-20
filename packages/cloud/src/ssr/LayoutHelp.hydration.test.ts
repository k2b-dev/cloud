import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../../..");
const sourceGlob = new Bun.Glob("packages/*/src/**/*.tsx");
const helpRegistration = /<Layout\.(?:HelpDocuments|HelpPage)(?:\s|>)/;

const withoutTsx = (path: string) => path.replace(/\.tsx$/, "");
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const isHelpRegistration = (path: string, source: string) =>
  path.endsWith("/ShellRuntime.island.tsx") || helpRegistration.test(withoutComments(source));
const loadSources = async () => {
  const sources = new Map<string, string>();
  for await (const path of sourceGlob.scan({ cwd: repoRoot })) {
    sources.set(normalize(path), await Bun.file(join(repoRoot, path)).text());
  }
  return sources;
};

const importedFiles = (path: string, source: string, sources: ReadonlyMap<string, string>) => {
  const imports: string[] = [];
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier?.startsWith(".")) continue;
    const resolved = normalize(join(dirname(path), specifier));
    const candidates = [`${resolved}.tsx`, join(resolved, "index.tsx")];
    const imported = candidates.find((candidate) => sources.has(candidate));
    if (imported) imports.push(imported);
  }
  return imports;
};

describe("Layout Help hydration boundaries", () => {
  test("interactive Help components are owned by exactly one island", async () => {
    const sources = await loadSources();

    const registrationFiles = [...sources]
      .filter(([path, source]) => path !== "packages/cloud/src/ssr/LayoutHelp.tsx" && isHelpRegistration(path, source))
      .map(([path]) => path);

    const importersOf = (target: string) => {
      const targetWithoutExtension = withoutTsx(target);
      const importers: string[] = [];

      for (const [path, source] of sources) {
        for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
          const specifier = match[1];
          if (!specifier?.startsWith(".")) continue;
          const importedPath = withoutTsx(normalize(join(dirname(path), specifier)));
          if (importedPath === targetWithoutExtension) importers.push(path);
        }
      }

      return importers;
    };
    const isOwnedByIsland = (path: string, visited = new Set<string>()): boolean => {
      if (visited.has(path)) return false;
      visited.add(path);
      const importers = importersOf(path);
      return (
        importers.length > 0 &&
        importers.every((importer) => importer.endsWith(".island.tsx") || isOwnedByIsland(importer, new Set(visited)))
      );
    };

    const invalid = registrationFiles.flatMap((path) => {
      const importers = importersOf(path);
      if (path.endsWith(".island.tsx")) {
        const nestedIslandImporters = importers.filter((importer) => importer.endsWith(".island.tsx"));
        return nestedIslandImporters.map((importer) => `${path} is nested inside ${importer}`);
      }

      return isOwnedByIsland(path) ? [] : [`${path} has a render path without an owning island`];
    });

    expect(registrationFiles.length).toBeGreaterThan(0);
    expect(invalid).toEqual([]);
  }, 30_000);

  test("every app page with a Help collection can reach its registrar", async () => {
    const sources = await loadSources();
    const registrationFiles = new Set(
      [...sources]
        .filter(([path, source]) => path !== "packages/cloud/src/ssr/LayoutHelp.tsx" && isHelpRegistration(path, source))
        .map(([path]) => path),
    );
    const helpPackages = new Set<string>();
    const automaticHelpPackages = new Set<string>();
    for await (const path of new Bun.Glob("packages/*/src/help/index.ts").scan({ cwd: repoRoot })) {
      const packageName = path.split("/")[1];
      if (!packageName) continue;
      helpPackages.add(packageName);
      const source = await Bun.file(join(repoRoot, path)).text();
      if (/\bdefineHelp\s*\(/.test(source)) automaticHelpPackages.add(packageName);
    }
    for (const path of registrationFiles) {
      const packageName = path.split("/")[1];
      if (packageName) helpPackages.add(packageName);
    }

    const reachesRegistrar = (entry: string, visited = new Set<string>()): boolean => {
      if (registrationFiles.has(entry)) return true;
      if (visited.has(entry)) return false;
      visited.add(entry);
      const source = sources.get(entry);
      if (!source) return false;
      return importedFiles(entry, source, sources).some((path) => reachesRegistrar(path, visited));
    };

    const appPages = [...sources]
      .filter(([path, source]) => {
        const packageName = path.split("/")[1];
        return !!packageName && helpPackages.has(packageName) && /<(?:Admin)?Layout(?:\s|>)/.test(withoutComments(source));
      })
      .map(([path]) => path);
    const missing = appPages.filter((path) => {
      const packageName = path.split("/")[1];
      return !packageName || (!automaticHelpPackages.has(packageName) && !reachesRegistrar(path));
    });

    expect(appPages.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  }, 30_000);
});

const articleHydrationFixture = await (async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", import.meta.dir))).default;
  const directory = mkdtempSync(join(tmpdir(), "help-article-hydration-"));
  const entry = resolve(import.meta.dir, "LayoutHelp.article-hydration-fixture.ts");
  const fixture = `
import { createComponent } from "solid-js";
import { LocaleProvider } from "@k2b/ui";
import { LayoutHelpPage } from "./LayoutHelp";
const article = (props) => createComponent(LocaleProvider, { locale: "en", get children() {
  return createComponent(LayoutHelpPage, props);
} });
`;
  try {
    const builds = await Promise.all(
      (["ssr", "dom"] as const).map((generate) =>
        Bun.build({
          entrypoints: [entry],
          files: {
            [entry]:
              fixture +
              (generate === "ssr"
                ? `
import { renderToString } from "solid-js/web";
export const run = (props) => renderToString(() => article(props));`
                : `
import { hydrate } from "solid-js/web";
export const run = (props, root) => hydrate(() => article(props), root);`),
          },
          target: generate === "ssr" ? "bun" : "browser",
          conditions: generate === "ssr" ? ["node"] : ["browser"],
          plugins: [
            {
              name: `help-article-${generate}`,
              setup(builder) {
                if (generate === "dom")
                  builder.onResolve({ filter: /^htmlparser2$/ }, () => {
                    throw new Error("Server-only HTML parser reached the island bundle");
                  });
                // UI's distributed SSR build has no hydration keys. Compile the same source tree on both sides.
                builder.onResolve({ filter: /^@k2b\/ui$/ }, () => ({ path: resolve(import.meta.dir, "../../../ui/src/index.ts") }));
                builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
                  const result = await transformAsync(await Bun.file(path).text(), {
                    filename: path,
                    babelrc: false,
                    configFile: false,
                    presets: [typescript, [solid, { generate, hydratable: true }]],
                  });
                  if (!result?.code) throw new Error(`Could not compile ${path}`);
                  return { contents: result.code, loader: "js" };
                });
              },
            },
          ],
        }),
      ),
    );
    for (const build of builds) {
      if (!build.success) throw new AggregateError(build.logs, "Could not compile article hydration fixture");
    }
    const serverPath = join(directory, "server.mjs");
    const clientPath = join(directory, "client.mjs");
    await Bun.write(serverPath, builds[0]!.outputs[0]!);
    await Bun.write(clientPath, builds[1]!.outputs[0]!);
    // Server rendering runs before a DOM exists, so an accidental browser splitter call fails here.
    const server = await import(serverPath);
    return { directory, server, clientPath };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
})();
afterAll(() => rmSync(articleHydrationFixture.directory, { recursive: true, force: true }));

test("an initial article hydrates the complete server frame without fetching its document", async () => {
  const { createDomTestHarness } = await import("../../../ui/test/dom");
  const { helpArticlePartsServer } = await import("./layout-help-article.server");
  const { server, clientPath } = articleHydrationFixture;
  {
    const { html: articleHtml, ...payload } = {
      id: "share",
      title: "Share a Space",
      locale: "en",
      kind: "task",
      needs: "edit",
      markdown: "Share",
      related: [],
      html: '<p>Share the Space with your team.</p><h2 id="invite">Invite people</h2><div class="help-steps"><ol><li>Open sharing.</li><li>Invite a person.</li></ol></div>',
    };
    const props = {
      platform: "other",
      initialTopic: "share",
      pageBase: "/help/apps/spaces",
      documents: [{ id: "share", title: payload.title, kind: "task", order: 1, url: "/api/help/share", searchUrl: "/api/help/search" }],
      initialArticle: { payload, parts: helpArticlePartsServer(articleHtml) },
    };
    for (const invalid of [
      { ...props, initialTopic: undefined },
      { ...props, initialTopic: "unknown" },
      { ...props, initialArticle: { ...props.initialArticle, payload: { ...payload, id: "other" } } },
      { ...props, documents: [] },
    ])
      expect(server.run(invalid)).not.toContain("Share the Space with your team.");
    const html: string = server.run(props);
    expect(html).toContain("Share the Space with your team.");
    expect(html).toContain('class="help-article-facts"');
    expect(html).toContain("Open sharing.");
    expect(html).not.toContain('data-state="loading"');
    const dom = createDomTestHarness();
    const fetch = spyOn(globalThis, "fetch");
    const hydration = Object.getOwnPropertyDescriptor(globalThis, "_$HY");
    let dispose: (() => void) | undefined;
    try {
      dom.root.innerHTML = html;
      const frame = () => {
        const template = document.createElement("template");
        template.innerHTML = dom.root.innerHTML;
        // Tooltips promote the server's native title to aria-describedby on mount.
        for (const element of template.content.querySelectorAll("[title], [aria-describedby]")) {
          element.removeAttribute("title");
          element.removeAttribute("aria-describedby");
        }
        return template.innerHTML;
      };
      const before = frame();
      const head = dom.root.querySelector(".help-article-head");
      Object.defineProperty(globalThis, "_$HY", {
        configurable: true,
        writable: true,
        value: { events: [], completed: new WeakSet(), r: {} },
      });
      // An island serializes its props; object identity is shared only within this client snapshot.
      const client = await import(clientPath);
      dispose = client.run(JSON.parse(JSON.stringify(props)), dom.root);
      expect(frame()).toBe(before);
      expect(dom.root.querySelector(".help-article-head")).toBe(head);
      await new Promise<void>((done) => requestAnimationFrame(() => done()));
      expect(dom.root.querySelector(".help-article-lead")?.textContent).toContain("Share the Space with your team.");
      expect(dom.root.querySelector('[data-state="loading"]')).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      dispose?.();
      fetch.mockRestore();
      dom.cleanup();
      if (hydration) Object.defineProperty(globalThis, "_$HY", hydration);
      else Reflect.deleteProperty(globalThis, "_$HY");
    }
  }
});
