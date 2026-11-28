import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";
import type { HelpReaderProps } from "./HelpReader";
import { helpReaderFixture, worstCaseHelpReaderFixture } from "./help-reader.fixture";

registerSsrTestPlugin({ dev: true, rootDir: mkdtempSync(join(tmpdir(), "help-reader-v2-render-")) });
const { HelpReader } = await import("./HelpReader");
const { LocaleProvider } = await import("@k2b/ui");

const render = (props: Partial<HelpReaderProps>, locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(HelpReader, { ...helpReaderFixture, ...props });
      },
    }),
  );
const parts = (html: string, name: string) => html.match(new RegExp(`data-k2-part="${name}"`, "g"))?.length ?? 0;
const section = (html: string, title: string) => html.includes(`aria-label="${title}"`);

test("the start renders the tasks, the kinds and the shortcuts", () => {
  const html = render({});
  expect(parts(html, "Workspace")).toBe(1);
  for (const title of ["What do you want to do?", "Look up", "Get started", "Everywhere"]) expect(section(html, title)).toBe(true);
  expect(html).toContain('href="/help/apps/spaces/share"');
  expect(html).toContain("Open global search");
  expect(parts(html, "Loading")).toBe(0);
  // No article is open: the list is the page, without a half-empty pane beside it.
  expect(html).not.toContain('data-detail=""');
  expect(parts(html, "Pane")).toBe(1);
});

test("an open article renders with the page, without a loading shape", () => {
  const html = render({ initialTopic: "share" });
  expect(html).toContain('data-detail=""');
  expect(html).toContain("Invite a person by name.");
  expect(html).toContain("2 steps");
  expect(html).toContain("You need");
  expect(parts(html, "Loading")).toBe(0);
  expect(html).toContain("Roles");
});

test("Help the reader may not see shows nothing of the app and nothing to search", () => {
  const html = render({ state: "unavailable", documents: [], app: undefined });
  expect(html).toContain("This Help is not available");
  expect(html).not.toContain('type="search"');
  expect(html).not.toContain("Share a Space");
});

test("an app without Help says so, a failed read offers to try again", () => {
  expect(render({ documents: [] })).toContain("No Help articles here yet");
  const failed = render({ documents: [], state: "failed" });
  expect(parts(failed, "Failed")).toBe(1);
});

test("German readers read German words and their platform's keys", () => {
  const html = render({ platform: "apple" }, "de");
  expect(html).toContain("Was möchtest du tun?");
  expect(html).toContain("⌘");
});

test("the worst case (long, unbreakable and many articles) renders every article once", () => {
  const html = render(worstCaseHelpReaderFixture);
  expect(html.match(/\/help\/apps\/spaces\/topic-/g)?.length).toBeGreaterThanOrEqual(worstCaseHelpReaderFixture.documents!.length);
  expect(parts(html, "Loading")).toBe(0);
});
