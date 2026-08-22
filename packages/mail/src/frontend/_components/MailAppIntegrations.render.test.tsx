import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "mail-app-integrations-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ default: MailCalendarInvitation }, { default: MailConversationContext }] = await Promise.all([
  import("./MailCalendarInvitation.tsx"),
  import("./MailConversationContext.tsx"),
]);

describe("Mail app integration states", () => {
  test("keeps contact and Space add actions compact and semantically labelled", () => {
    const source = readFileSync(new URL("./MailConversationContext.tsx", import.meta.url), "utf8");

    expect(source).toContain('class="ti ti-user-plus text-[var(--app-accent)]"');
    expect(source).toContain("title={participant.email}");
    expect(source).not.toContain("title={participant.displayName || participant.email}");
    expect(source).toContain('class="ti ti-link-plus text-[var(--k2b-action)]"');
    expect(source.match(/text-\[var\(--k2b-action\)\]/g)).toHaveLength(3);
    expect(source).toContain('title="Link Spaces"');
    expect(source).toContain(">existing item</span>");
    expect(source).toContain('title="Spaces Task"');
    expect(source).toContain('title="Spaces Event"');
    expect(source.match(/>new item<\/span>/g)).toHaveLength(2);
    expect(source.match(/target="_blank"/g)).toHaveLength(3);
    expect(source.match(/rel="noopener noreferrer"/g)).toHaveLength(3);
    expect(source).toContain('label: "Related Mail"');
    expect(source).not.toContain('title="Related Mail"');
    expect(source).toContain('label: "Unlink"');
    expect(source).not.toContain("aria-label={`Unlink ${item.title}`}");
  });

  test("exposes calendar invitation loading through the shared region contract", () => {
    const html = renderToString(() =>
      createComponent(MailCalendarInvitation, {
        mailboxId: "11111111-1111-4111-8111-111111111111",
        messageId: "22222222-2222-4222-8222-222222222222",
        requestUrl: "https://cloud.example.test/app/mail",
        canWrite: true,
        dateConfig: { locale: "en", timeZone: "Europe/Berlin" },
      }),
    );

    expect(html).toContain('class="k2b-placeholder');
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Reading calendar invitation");
  });

  test("exposes Contacts and Spaces loading through the shared region contract", () => {
    const html = renderToString(() =>
      createComponent(MailConversationContext, {
        mailboxId: "11111111-1111-4111-8111-111111111111",
        conversationId: "33333333-3333-4333-8333-333333333333",
        requestUrl: "https://cloud.example.test/app/mail/11111111-1111-4111-8111-111111111111",
        active: true,
      }),
    );

    expect(html).toContain('class="k2b-placeholder');
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading contacts...");
    expect(html).toContain("Loading Spaces...");
    expect(html.match(/data-align="center"/g)?.length).toBe(2);
    expect(html).not.toContain("Spaces unavailable");
    expect(html).toContain('aria-label="Contacts" class="bg-[var(--ui-surface)] p-3"');
    expect(html).toContain('aria-label="Spaces" class="space-y-1 bg-[var(--ui-surface)] p-3"');
    expect(html).not.toContain("border-t");
  });
});
