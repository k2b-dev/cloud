import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent, createRoot } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "assistant-empty-chat-"));
const serovalLink = resolve(import.meta.dir, "../../node_modules/seroval");
const createdSerovalLink = !existsSync(serovalLink);
if (createdSerovalLink) symlinkSync(resolve(import.meta.dir, "../../../cloud/node_modules/seroval"), serovalLink, "dir");
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (createdSerovalLink) unlinkSync(serovalLink);
});

const { createCodeApprovals } = await import("./CapabilityApproval");
const { LocaleProvider } = await import("@k2b/ui");

import type { CapabilityApproval } from "./runtime/capabilities";

test("pending code approval remains visible outside its originating chat and names shared data access", async () => {
  const approvals = createRoot(() => createCodeApprovals());
  const signal = new AbortController();
  const request = {
    status: "approval",
    id: "00000000-0000-4000-8000-000000000001",
    name: "contacts.list",
    input: {},
    appId: "contacts",
    appName: "Contacts",
    appIcon: "ti ti-address-book",
    localId: "list",
    kind: "query",
    schemaHash: "test",
    approval: null,
    title: "Read contacts",
    review: null,
    allowAlways: false,
    scope: null,
    resource: { id: "00000000-0000-4000-8000-000000000002", title: "Shared app" },
  } satisfies CapabilityApproval;
  const pending = approvals.ask(request, signal.signal, "old-chat").catch((error) => error.message);
  const html = renderToString(() =>
    createComponent(approvals.View, { conversationTitle: (id) => (id === "old-chat" ? "Original chat" : undefined) }),
  );
  expect(html).toContain("Original chat");
  expect(html).toContain("Shared app");
  expect(html).toContain("personal remembered approvals");
  signal.abort();
  expect(await pending).toBe("Run stopped");
  expect(renderToString(() => createComponent(approvals.View, { conversationTitle: () => undefined }))).not.toContain("Shared app");
});

test("code approvals present the capability in the reader's language", async () => {
  const approvals = createRoot(() => createCodeApprovals());
  const signal = new AbortController();
  const request = {
    status: "approval",
    id: "00000000-0000-4000-8000-000000000003",
    name: "mail.draft.create",
    input: { subject: "Angebot" },
    appId: "mail",
    appName: "Mail",
    appIcon: "ti ti-mail",
    localId: "draft.create",
    kind: "action",
    schemaHash: "test",
    approval: "rememberable",
    title: "Entwurf erstellen",
    review: null,
    allowAlways: true,
    scope: "mailbox:1",
  } satisfies CapabilityApproval;
  const pending = approvals.ask(request, signal.signal).catch((error) => error.message);
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(approvals.View, { conversationTitle: () => undefined });
      },
    }),
  );
  expect(html).toContain("Mail · Entwurf erstellen");
  expect(html).toContain("ti-mail");
  expect(html).toContain("Wird erst nach deiner Freigabe ausgeführt");
  expect(html).toContain("Ablehnen");
  expect(html).toContain("Immer freigeben");
  expect(html).toContain('aria-label="Freigabe erforderlich: Entwurf erstellen"');
  expect(html).not.toContain("Mail: Entwurf erstellen");
  expect(html).not.toMatch(/>(Reject|Action|Always approve)</);
  signal.abort();
  expect(await pending).toBe("Run stopped");
});

test("an approval from managed code reads as the app's localized review, never as raw JSON", async () => {
  const { codeApprovalMessage } = await import("./code-approval-message");
  const { AiChatActionsProvider, AiTurnBlockView } = await import("@k2b/cloud/ai/ui");
  const request = {
    status: "approval",
    id: "00000000-0000-4000-8000-000000000004",
    name: "mail.draft.create",
    input: { subject: "Angebot" },
    appId: "mail",
    appName: "E-Mail",
    appIcon: "ti ti-mail",
    localId: "draft.create",
    kind: "action",
    schemaHash: "test",
    approval: null,
    title: "Mail-Entwurf erstellen",
    review: {
      message: "Die E-Mail wird als Entwurf gespeichert und nicht gesendet.",
      details: [
        { label: "Betreff", value: "Angebot" },
        { label: "Inhalt", value: "Hallo\nanbei das Angebot.", display: "block" },
      ],
    },
    allowAlways: false,
    scope: null,
  } satisfies CapabilityApproval;
  const message = codeApprovalMessage(request, "de");
  expect(message).toBe(
    "E-Mail: Mail-Entwurf erstellen\nDie E-Mail wird als Entwurf gespeichert und nicht gesendet.\nBetreff: Angebot\nInhalt:\nHallo\nanbei das Angebot.",
  );
  // Without a review, the person still sees each input field.
  expect(codeApprovalMessage({ ...request, review: null }, "de")).toBe("E-Mail: Mail-Entwurf erstellen\nsubject: Angebot");
  const http = codeApprovalMessage(
    {
      type: "http",
      name: "http.fetch:https://api.example.test",
      id: "00000000-0000-4000-8000-000000000005",
      url: "https://api.example.test/items",
      method: "POST",
      headers: { authorization: { secret: "API_TOKEN", prefix: "Bearer " } },
      bodyBytes: 13,
      bodyPreview: '{"name":"x"}',
      bodyTruncated: false,
    },
    "de",
  );
  expect(http.split("\n")[0]).toBe("Externer HTTP-Aufruf: POST https://api.example.test/items");
  expect(http).toContain("authorization: Bearer [Secret „API_TOKEN“]");
  expect(http).toContain('Inhalt (13 B): {"name":"x"}');

  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(AiChatActionsProvider, {
          actions: { onApproval: () => undefined },
          get children() {
            return createComponent(AiTurnBlockView, {
              active: true,
              turnId: "turn",
              block: {
                id: "code",
                kind: "tool",
                callId: "code",
                name: "code_run",
                args: { code: "await mail.draft.create({ subject: 'Angebot' })" },
                status: "awaiting_approval",
                approval: { message, allowAlways: false },
              },
            });
          },
        });
      },
    }),
  );
  expect(html).toContain("Die E-Mail wird als Entwurf gespeichert und nicht gesendet.");
  expect(html).toMatch(/<strong[^>]*>Betreff: <\/strong>(<!--[^>]*-->)*Angebot/);
  expect(html).not.toContain("Code execution requests approval");
  expect(html).not.toContain("&quot;status&quot;");
});
