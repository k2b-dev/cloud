import { expect, test } from "bun:test";
import { sideEffectModules } from "./cloud-side-effects";

const found = (files: Record<string, string>) => Object.fromEntries(sideEffectModules(new Map(Object.entries(files))));

test("a module that registers on import is found; one that only defines things is not", () => {
  expect(
    found({
      // a registry another module reads by key
      "src/channels.ts":
        "const drivers = new Map();\nexport const registerChannel = (d) => { drivers.set(d.id, d); };\nexport const channel = (id) => drivers.get(id);\nregisterChannel({ id: 'mail' });",
      // registers through a function of another module, in an initializer
      "src/browser.ts": "import { registerChannel } from './channels';\nexport const stop = registerChannel({ id: 'browser' });",
      // imported for its effect alone
      "src/index.ts": "import './browser';\nexport { channel } from './channels';",
      // only definitions: schemas, catalogs, functions whose effects run when they are called
      "src/schemas.ts":
        "import { z } from 'zod';\nimport { i18n } from '@k2b/stdlib';\nexport const Mail = z.object({ at: z.string().datetime() }).strict();\nexport const messages = i18n.define({ en: { hi: 'Hi' } });\nexport const listen = () => window.addEventListener('focus', () => {});",
      // a global effect and an object that listens
      "src/live.ts": "window.addEventListener('pagehide', () => {});\nexport const channel = new BroadcastChannel('cloud');",
      // a registration named like one, from another package
      "src/plugin.ts": "import { registerPlugin } from 'other';\nexport const plugin = registerPlugin({ id: 'x' });",
    }),
  ).toEqual({
    "src/channels.ts": ["runs `registerChannel({ id: 'mail' })`"],
    "src/browser.ts": ["calls registerChannel", "src/index.ts imports it for its effect"],
    "src/live.ts": ["runs `window.addEventListener('pagehide', () =`", "makes a BroadcastChannel"],
    "src/plugin.ts": ["calls registerPlugin"],
  });
});
