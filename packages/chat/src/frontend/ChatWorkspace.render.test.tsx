import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "chat-workspace-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { LocaleProvider } = await import("@k2b/ui");
const { default: ChatWorkspace } = await import("./ChatWorkspace");

const render = (locale: string) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(ChatWorkspace, {});
      },
    }),
  );

describe("ChatWorkspace", () => {
  test("shows the empty chat list and work area in the inherited locale", () => {
    const english = render("en");
    expect(english).toContain("k2b-app-workspace");
    expect(english).toContain("None yet");
    expect(english).toContain("No chats yet");
    expect(english).toContain("Chats you belong to appear here.");

    const german = render("de-DE");
    expect(german).toContain("Noch keine Chats");
    expect(german).toContain("Chats, in denen du Mitglied bist, erscheinen hier.");
    expect(german).not.toContain("No chats yet");
  });
});
