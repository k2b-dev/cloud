import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

// The initials a v1 avatar shows come from the words of the name that have a letter or a digit: a "·", a "—", a "&"
// or an emoji is no part of the name.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-avatar-initials-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Avatar } = await import("./Avatar");

const initials = (name: string) =>
  renderToString(() => createComponent(Avatar, { name }))
    .match(/role="img"[^>]*>((?:<!--[^>]*-->)*)([^<]*)/)?.[2]
    ?.trim();

test("a v1 avatar takes its initials from the words that have a letter or a digit", () => {
  const cases: [string, string][] = [
    ["東京オフィス · 物流チーム", "東物"],
    ["Ada Renz —", "AR"],
    ["Müller & Söhne", "MS"],
    ["Sommerfest 🎉", "SO"],
    ["A B", "AB"],
    ["(Ada) Renz", "AR"],
    ["ada.renz@example.org", "AD"],
    // Arabic letters keep their isolated form: a zero-width non-joiner stands between them
    ["محمد علي", "م\u200Cع"],
    ["محمد", "م\u200Cح"],
  ];
  for (const [name, expected] of cases) expect({ name, initials: initials(name) }).toEqual({ name, initials: expected });
});
