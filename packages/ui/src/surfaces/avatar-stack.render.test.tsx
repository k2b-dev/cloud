import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-avatar-stack-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { AvatarStack } = await import("./AvatarStack");

const people = [
  { id: "me", name: "Anna Becker", self: true, detail: "writing" },
  { id: "jana", name: "Jana Berger", src: "/jana.png", detail: "writing · Intake" },
  { id: "bot", name: "Stock bot", shape: "square" as const, icon: "ti ti-robot", badge: "Agent" },
  { id: "paul", name: "Paul Wagner", trailing: "2 tabs" },
  { id: "mira", name: "Mira Schulz" },
  { id: "tom", name: "Tom Krüger" },
];

describe("AvatarStack", () => {
  test("shows three faces without the viewer, then +n, as one labelled button", async () => {
    const html = renderToString(() => createComponent(AvatarStack, { people, title: "Here now", label: "Here now: 5 people" }));
    // The server disposes the render after it returns; nothing in that cleanup may reach for browser globals.
    await Bun.sleep(0);
    const faces = html.slice(html.indexOf("k2b-avatar-stack__faces"), html.indexOf("k2b-avatar-stack__more"));
    expect(faces).toContain('src="/jana.png"');
    expect(faces).toContain('data-shape="square"');
    expect(faces).toContain("PW");
    expect(faces).not.toContain("AB");
    expect(faces).not.toContain("MS");
    expect(html).toContain('aria-hidden="true" title="2 more">+2</span>');
    expect(html).toContain('aria-label="Here now: 5 people"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
  });

  test("lists everyone in the popover with a count, and the viewer last", () => {
    const html = renderToString(() =>
      createComponent(AvatarStack, { people, title: "Here now", label: "Here now", hint: "Click a person to jump to them." }),
    );
    expect(html).toMatch(/popover="auto" role="dialog" aria-labelledby="[^"]+-title" class="k2b-avatar-stack__popover"/);
    const list = html.slice(html.indexOf("k2b-avatar-stack__popover"));
    expect(list).toMatch(/<h3 id="[^"]+">Here now<\/h3><span class="k2b-count-chip">6<\/span>/);
    expect(list.indexOf("Tom Krüger")).toBeLessThan(list.indexOf("Anna Becker"));
    expect(list).toContain('data-self="true"');
    expect(list).toContain("Agent");
    expect(list).toContain("2 tabs");
    expect(list).toContain("Click a person to jump to them.");
  });
});
