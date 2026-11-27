import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rule, sideEffectModules } from "./cloud-side-effects";

const found = (files: Record<string, string>, aliases: Record<string, string[]> = {}) =>
  [...sideEffectModules(new Map(Object.entries(files)), aliases).keys()].sort();

// a registry another module reads by key
const registry =
  "const drivers = new Map();\nexport const registerDriver = (d) => { drivers.set(d.id, d); };\nexport const driver = (id) => drivers.get(id);\nexport const registry = { add: (d) => drivers.set(d.id, d) };";

test("every way a module can do something on import is found", () => {
  const cases: Record<string, string> = {
    "src/registry.ts": registry,
    "src/if.ts": "if (typeof window !== 'undefined') window.addEventListener('keydown', () => {});",
    "src/try.ts": "try { globalThis.ready = true; } catch {}",
    "src/for.ts": "import { registerDriver } from './registry';\nfor (const id of ['a', 'b']) registerDriver({ id });",
    "src/default.ts": "import { registerDriver } from './registry';\nexport default registerDriver({ id: 'default' });",
    "src/iife.ts": "export const ready = (() => { window.addEventListener('focus', () => {}); return true; })();",
    "src/static-block.ts": "export class Plugin { static { console.log('loaded'); } }",
    "src/static-field.ts":
      "import { registerDriver } from './registry';\nexport class Plugin { static off = registerDriver({ id: 'p' }); }",
    "src/wrapper.ts":
      "import { registerDriver } from './registry';\nconst wrap = (d) => registerDriver(d);\nexport const off = wrap({ id: 'w' });",
    "src/global.ts": "export const store = (globalThis.__store ??= new Map());",
    "src/method.ts": "import { registry } from './registry';\nexport const off = registry.add({ id: 'm' });",
    "src/polyfill.ts": "import 'some-polyfill';\nexport const x = 1;",
    "src/alias.ts": "import '#setup';\nexport const y = 1;",
    "src/setup.ts": "export const z = 1;",
    // through an index and a re-export
    "src/channels/index.ts": "export { registerDriver as add } from '../registry';",
    "src/via-index.ts": "import { add } from './channels';\nexport const off = add({ id: 'i' });",
  };
  expect(found(cases, { "#setup": ["src/setup.ts"] })).toEqual([
    "src/alias.ts",
    "src/default.ts",
    "src/for.ts",
    "src/global.ts",
    "src/if.ts",
    "src/iife.ts",
    "src/method.ts",
    "src/polyfill.ts",
    "src/setup.ts",
    "src/static-block.ts",
    "src/static-field.ts",
    "src/try.ts",
    "src/via-index.ts",
    "src/wrapper.ts",
  ]);
});

test("definitions, caches, markers and catalogs do nothing on import", () => {
  expect(
    found({
      "src/registry.ts": registry,
      "src/schemas.ts":
        "import { z } from 'zod';\nimport { i18n } from '@k2b/stdlib';\nexport const Mail = z.object({ at: z.string().datetime() }).strict();\nexport const messages = i18n.define({ en: { hi: 'Hi' } });",
      // a function whose effect runs when it is called
      "src/later.ts":
        "import { registerDriver } from './registry';\nexport const start = () => { window.addEventListener('focus', () => {}); registerDriver({ id: 'l' }); };",
      // a cache only its own function reads
      "src/memo.ts":
        "const instances = new Map();\nconst cached = (key) => { const hit = instances.get(key) ?? { key }; instances.set(key, hit); return hit; };\nexport const content = cached('content');",
      // a marker only the holder of the object can read
      "src/marker.ts":
        "const marked = new WeakSet();\nconst mark = (handler) => { marked.add(handler); return handler; };\nexport const isMarked = (h) => marked.has(h);\nexport const handler = mark(() => {});",
      // state its returned methods write later
      "src/service.ts":
        "let busy = false;\nexport const busyNow = () => busy;\nconst createService = () => ({ start: () => { busy = true; } });\nexport const service = createService();",
      // a computed constant
      "src/constant.ts": "export const squares = (() => { const out = []; for (let i = 0; i < 4; i++) out.push(i * i); return out; })();",
    }),
  ).toEqual([]);
});

const workspaces: string[] = [];
afterAll(async () => {
  for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true });
});
/** The rule's findings for a package with these files and this `sideEffects` list. */
const run = async (files: Record<string, string>, sideEffects: string[] | undefined, imports: Record<string, string> = {}) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "cloud-side-effects-"));
  workspaces.push(workspaceRoot);
  const root = join(workspaceRoot, "packages", "cloud");
  await Bun.write(join(root, "package.json"), JSON.stringify({ name: "@k2b/cloud", ...(sideEffects ? { sideEffects } : {}), imports }));
  for (const [file, text] of Object.entries(files)) await Bun.write(join(root, file), text);
  const findings = await rule.run({ workspaceRoot, fix: false, flags: new Set() });
  return findings.map((finding) => `${finding.file?.slice(root.length + 1) ?? ""}: ${finding.message.split(";")[0]}`).sort();
};

test("the rule asks for each module that does something and for no module that does nothing", async () => {
  const files = {
    "src/registry.ts": registry,
    "src/channels/index.ts": "import './browser';\nexport { registerDriver } from '../registry';",
    "src/channels/browser.ts": "import { registerDriver } from '../registry';\nregisterDriver({ id: 'browser' });",
    "src/pure.ts": "export const one = 1;",
    "src/run-worker.ts": "addEventListener('message', () => {});",
    "src/run.test.ts": "registerDriver({ id: 'test' });",
    "scripts/used.ts": "process.on('exit', () => {});\nexport const used = 1;",
    "scripts/unused.ts": "process.on('exit', () => {});",
    "src/uses-script.ts": "export { used } from '../scripts/used';",
    "src/styles.css": ".a {}",
  };
  expect(await run(files, undefined)).toEqual(["package.json: sideEffects must be a list of the modules whose import does something"]);
  // an index resolves, a used script counts, workers, tests and unused scripts do not
  expect(await run(files, ["**/*.css"])).toEqual([
    "scripts/used.ts: does something on import (runs `process.on('exit', () => {})",
    "src/channels/browser.ts: does something on import (src/channels/index.ts imports it for its effect",
    "src/channels/index.ts: does something on import (imports ./browser for its effect)",
  ]);
  // a glob covers what it matches; an exact entry that does nothing is stale
  expect(await run(files, ["**/*.css", "./src/channels/**", "./scripts/used.ts", "./src/pure.ts"])).toEqual([
    "package.json: sideEffects lists ./src/pure.ts, which does nothing on import (or is not scanned)",
  ]);
  expect(await run(files, ["**/*.css", "./src/channels/browser.ts", "./src/channels/index.ts", "./scripts/used.ts"])).toEqual([]);
});
