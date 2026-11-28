import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "tools-password-render-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { LocaleProvider } = await import("@k2b/ui");
const { default: PasswordGenerator } = await import("./PasswordGenerator.island.tsx");

const render = () =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(PasswordGenerator, {});
      },
    }),
  );

test("the server renders no password, and the chips the browser shows after it made one", () => {
  const html = render();
  // the drawing's signs are empty: no secret in the markup, and nothing the island would replace with another one
  expect(html).toMatch(/font-size:min\([^"]*"><\/span>/);
  expect(html).toContain("Stärke: –");
  // the chips come from the settings (20 signs with upper case, lower case and digits), as after mount
  const chips = [...html.matchAll(/data-k2-part="Chip"[^>]*><span class="k2-chip-text">([^<]+)</g)].map((match) => match[1]);
  expect(chips).toEqual(["20 Zeichen", "Großbuchstaben", "Kleinbuchstaben", "Ziffern"]);
});
