import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import { codeVersionChatAnchor } from "./review-contracts";

const rootDir = mkdtempSync(join(tmpdir(), "code-async-anchor-"));
registerSsrTestPlugin({ dev: true, rootDir });

const { ApprovalFrame } = await import("@k2b/cloud/approvals/ui");
const original = "11111111-1111-4111-8111-111111111111";
const renewed = "22222222-2222-4222-8222-222222222222";

test("Code navigation targets the version card's ApprovalFrame DOM anchor, including renewal", () => {
  // AssistantCodeVersionCard gives its first version's ID to ApprovalFrame, even after Ask again.
  const html = renderToString(() =>
    createComponent(ApprovalFrame, {
      locale: "en",
      state: "open",
      source: { name: "Code", icon: "ti ti-code" },
      reason: { text: "Fixture" },
      anchorId: `code-version-${original}`,
    }),
  );
  const domAnchor = html.match(/data-chat-anchor="([^"]+)"/)?.[1];
  if (!domAnchor) throw new Error("Version card has no DOM anchor");
  expect(domAnchor).toBe(`code-version-${original}`);
  const origin = { kind: "ai_chat" as const, conversationId: original, automaticAfterReview: false, cardAnchor: "tool-submit" };
  expect(codeVersionChatAnchor(original, origin)).toBe(domAnchor);
  expect(codeVersionChatAnchor(original, { kind: "cli" })).toBe(domAnchor);
  const renewalOrigin = { ...origin, cardAnchor: codeVersionChatAnchor(original, origin) };
  expect(codeVersionChatAnchor(renewed, renewalOrigin)).toBe(domAnchor);
});
