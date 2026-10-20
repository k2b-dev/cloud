import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "mail-compose-intent-icon-tile-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailComposeIntentPage } = await import("./MailComposeIntentPage.island.tsx");
const { DEFAULT_MAIL_CONTACT_DIRECTORY } = await import("../../contact-directory-settings");

test("compose intent renders its pencil in a shared tile with app ink", () => {
  const html = renderToString(() =>
    createComponent(MailComposeIntentPage, {
      mailboxes: [{ id: "Mail01", name: "Mailbox", description: null, canManage: false }],
      initialMailboxId: "",
      autoStart: false,
      mailto: null,
      returnHref: null,
      contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
      currentUserEmail: null,
    }),
  );
  const icon = html.match(/<span\b([^>]*)>\s*<i class="ti ti-pencil"/)?.[1];
  const classes = icon?.match(/\bclass="([^"]*)"/)?.[1]?.split(/\s+/);
  expect(icon).toBeDefined();
  expect(classes).toContain("k2b-icon-tile");
  expect(classes).toContain("app-accent-text");
  expect(icon).not.toMatch(/\bstyle\s*=/);
  expect(html).not.toMatch(/color-mix\([^;"}]*--app-accent/);
  expect(html).not.toContain("bg-[var(--ui-selected)]");
});
