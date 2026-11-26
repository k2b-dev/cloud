import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { buildIslands } from "../../../ssr/src/build";
import { islandIdFromFile } from "../../../ssr/src/island-id";
import { transform } from "../../../ssr/src/transform";

// No shared per-island budget mechanism exists on origin/main. The actual Chat
// production graph fell from 1,656,362 bytes (entry 841,920) to 1,264,263
// (entry 486,732). Keep a small margin, plus a separate static-import guard.
const ENTRY_BUDGET = 500 * 1024;
const STATIC_BUDGET = 1280 * 1024;
// The full page's v2 island: v1's closure without v1's frame, plus @k2b/ui v2 and its behaviour layer (measured
// 1,605,900 bytes on 26.11.2026, Bun 1.4.2; a small margin as above).
const V2_STATIC_BUDGET = 1600 * 1024;

for (const island of ["ChatWorkspace.island.tsx", "ChatWorkspaceV2.island.tsx"])
  test(`Chat keeps dialogs, subpages, YAML and dictation outside the initial JS of ${island}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "chat-bundle-budget-"));
    const entry = resolve(import.meta.dir, island);
    try {
      const result = await Bun.build({
        entrypoints: [entry],
        outdir: directory,
        target: "browser",
        conditions: ["browser", "production"],
        define: { "process.env.NODE_ENV": '"production"' },
        minify: true,
        splitting: true,
        metafile: true,
        plugins: [
          {
            name: "chat-budget-solid",
            setup(build) {
              build.onResolve({ filter: /^solid-js(?:\/(?:web|store))?$/ }, (args) => {
                const module = args.path === "solid-js" ? "solid" : args.path.slice("solid-js/".length);
                return { path: Bun.resolveSync(`${args.path}/dist/${module}.js`, import.meta.dir) };
              });
              build.onLoad({ filter: /\.(tsx|jsx)$/ }, async ({ path }) => ({
                contents: await transform(await Bun.file(path).text(), path, "dom"),
                loader: "js",
              }));
            },
          },
        ],
      });
      if (!result.success || !result.metafile) throw new AggregateError(result.logs, "Chat budget build failed");
      const outputs = new Map(Object.entries(result.metafile.outputs).map(([path, value]) => [basename(path), value]));
      const first = [...outputs].find(([, output]) => output.entryPoint && resolve(output.entryPoint) === entry);
      if (!first) throw new Error("Chat entry missing");
      const closure = new Set([first[0]]);
      for (const path of closure) {
        for (const edge of outputs.get(path)?.imports ?? []) {
          if (edge.kind === "import-statement" && outputs.has(basename(edge.path))) closure.add(basename(edge.path));
        }
      }
      const inputs = [...closure].flatMap((path) => Object.keys(outputs.get(path)!.inputs)).join("\n");
      for (const module of [
        "NewChatDialog",
        "AddPeopleDialog",
        "ChannelDialogs",
        "ChatDetailsDialog",
        "LeaveChatDialog",
        "ThreadDialog",
        "MessageMutationDialog",
        "ChatInfoPanel",
        "ChatNotificationSettings",
        "ChatThreadsPage",
        "ChatThreadColumn",
        "DiscoverChannels",
        "ForYou.tsx",
        "ChatSearch.tsx",
        "live-dictation-browser",
        "browser/resource-picker",
        "yaml/",
      ])
        expect(inputs).not.toContain(module);
      // The panel and the Cloud app keep v1's frame and load none of @k2b/ui v2; only the full page's island draws v2.
      if (island === "ChatWorkspace.island.tsx") expect(inputs).not.toMatch(/\/frontend\/v2\/|\/ui\/[^\n]*\/v2\//);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

test("the production Chat island entry and its preload closure stay within their measured budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-production-budget-"));
  const root = resolve(import.meta.dir, "../../../..");
  try {
    await buildIslands({
      pattern: "**/*.{island,client}.tsx",
      outdir: directory,
      cwd: root,
      componentRoots: [join(root, "packages/chat/src"), join(root, "packages/cloud/src")],
      errorFallback: join(root, "packages/cloud/src/ssr/IslandError.tsx"),
      verbose: false,
    });
    const manifest = (await Bun.file(join(directory, "manifest.json")).json()) as { entries: Record<string, string[]> };
    const sizes = (island: string) => {
      const files = manifest.entries[islandIdFromFile(join(root, `packages/chat/src/frontend/${island}`), root)];
      if (!files?.length) throw new Error(`Production Chat island missing: ${island}`);
      return {
        entry: Bun.file(join(directory, files[0]!)).size,
        static: files.reduce((bytes, file) => bytes + Bun.file(join(directory, file)).size, 0),
      };
    };
    const v1 = sizes("ChatWorkspace.island.tsx");
    const v2 = sizes("ChatWorkspaceV2.island.tsx");
    console.info(
      `Chat production budget (Bun ${Bun.version}): v1 entry ${v1.entry}/${ENTRY_BUDGET}, static ${v1.static}/${STATIC_BUDGET} bytes; v2 static ${v2.static}/${V2_STATIC_BUDGET} bytes`,
    );
    expect(v1.entry).toBeLessThanOrEqual(ENTRY_BUDGET);
    expect(v1.static).toBeLessThanOrEqual(STATIC_BUDGET);
    expect(v2.static).toBeLessThanOrEqual(V2_STATIC_BUDGET);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
