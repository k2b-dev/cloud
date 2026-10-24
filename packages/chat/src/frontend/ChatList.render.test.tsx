import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "chat-list-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { ChatAvatar } = await import("./ChatList");
type Row = Parameters<typeof ChatAvatar>[0]["row"];
const avatar = (row: Partial<Row>) =>
  renderToString(() =>
    createComponent(ChatAvatar, { row: { title: "Delivery board", kind: "chat", channel: false, icon: null, resource: null, ...row } }),
  );

test("a chat shows its initials in the tint of its name, the same tint for the same name", () => {
  const html = avatar({});
  expect(html).toContain(">DB<");
  expect(html).not.toContain("data-shape");
  const tint = html.match(/data-tint="(\d+)"/)?.[1];
  expect(tint).toBeDefined();
  expect(avatar({ icon: null })).toContain(`data-tint="${tint}"`);
});

test("a chosen icon replaces the initials; a channel without one shows its sign", () => {
  expect(avatar({ icon: "ti ti-rocket" })).toContain('class="ti ti-rocket"');
  expect(avatar({ channel: true })).toContain('class="ti ti-speakerphone"');
  expect(avatar({ channel: true, icon: "ti ti-run" })).toContain('class="ti ti-run"');
});

test("a Space's or notebook's chat is a square with the container's sign, whatever icon it carries", () => {
  const html = avatar({ kind: "system", icon: "ti ti-rocket", resource: { type: "notebooks.notebook", id: "Book01" } });
  expect(html).toContain('data-shape="square"');
  expect(html).not.toContain("ti-rocket");
  expect(html).toMatch(/class="ti ti-[a-z-]+"/);
});
