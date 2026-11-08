import { expect, spyOn, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { CODE_CHECK_LIMITS, type CodeSdkBridge, createCodeTestBridge, generateCodeSdk } from "@k2b/cloud/code";
import type { AppEventEnvelope } from "@k2b/cloud/events";
import { z } from "zod";
import { mailCapabilities } from "../../../mail/src/capabilities";
import { previewCodeEvent } from "./event-preview";

const event = {
  id: "00000000-0000-4000-8000-000000000001",
  type: "mail.message.received",
  version: 1,
  source: "mail",
  time: "2026-11-01T12:00:00Z",
  subject: { type: "mail.message", id: "Msg123" },
  place: { type: "mail.mailbox", id: "Box123" },
  data: { receiptId: "00000000-0000-4000-8000-000000000002" },
};
const entrypoint = "event:mail.message.received@1";
const message = {
  id: "Msg123",
  mailboxId: "Box123",
  conversationId: "Con123",
  subject: "Invoice",
  subjectTruncated: false,
  messageId: null,
  internalDate: event.time,
  sentAt: null,
  from: [],
  to: [],
  addressesTruncated: false,
  flags: [],
  flagsTruncated: false,
  keywords: ["important"],
  keywordsTruncated: false,
  hydrationStatus: "complete",
  remoteAvailable: true,
  contentType: "text/plain",
  sizeBytes: 20,
  replyTo: [],
  cc: [],
  detailAddressesTruncated: false,
  headers: [],
  headersTruncated: false,
  text: "A real-message fixture",
  bodyTruncated: false,
  attachments: [],
  attachmentsTruncated: false,
  delivery: null,
};

test("Mail preview invokes its real SDK app.on handler through the simulator and records a would-be effect without calling Mail Actions", async () => {
  const sdk = generateCodeSdk([compileCapabilityManifest("mail", mailCapabilities)], {
    mode: "resource",
    owner: { kind: "resource", ref: event.place },
  });
  const manifest = {
    version: 1 as const,
    hashes: { source: "a".repeat(64), bundle: "b".repeat(64), sdk: "c".repeat(64) },
    entrypoints: [
      {
        kind: "event" as const,
        entrypoint,
        cron: null,
        file: "code.ts",
        line: 1,
        event: { type: event.type, version: 1, place: event.place },
      },
    ],
    permissions: [],
    ai: false,
  };
  const effect = spyOn(mailCapabilities.actions["conversation.mark"], "run").mockImplementation(async () => {
    throw new Error("real_effect_forbidden");
  });
  let checked = false;
  try {
    const result = await previewCodeEvent(
      { sdk, files: { "code.ts": "trusted fixture" }, entry: "code.ts", aiOperations: [], limits: CODE_CHECK_LIMITS },
      entrypoint,
      {
        event,
        mocks: [{ operation: "mail.message.read", target: null, input: { id: "Msg123" }, replies: [{ ok: true, data: message }] }],
      },
      {
        limits: { requestBytes: 8 * 1024 * 1024, outputBytes: 2 * 1024 * 1024, cases: 1, runs: 1, calls: 10, wallClockMs: 10000 },
        check: async () => {
          checked = true;
          return { ok: true, bundle: "trusted fixture", manifest, permissions: [], diagnostics: [] };
        },
        execute: async (request) => {
          expect(checked).toBe(true);
          expect(request.mode).toBe("simulate");
          const fixture = request.cases[0]!.fixture;
          expect(fixture.runs).toEqual([{ entrypoint, input: event }]);
          const bridge = createCodeTestBridge(sdk.manifest, fixture.mocks);
          bridge.begin();
          const runtime: {
            app: { on(type: string, handler: (event: AppEventEnvelope) => Promise<void>): void };
            mail: { app(): { message: { read(input: object): Promise<{ data: typeof message }> } } };
            owner: { conversation: { mark(input: object): Promise<void> } };
            __codeSdk: { bind(bridge: CodeSdkBridge): void; run(entrypoint: string, input: unknown): Promise<unknown> };
          } = await import(`data:text/javascript;base64,${Buffer.from(sdk.runtime).toString("base64")}`);
          runtime.__codeSdk.bind({ call: (operation, input) => bridge.call(operation, z.json().parse(input)) });
          runtime.app.on(event.type, async (received) => {
            const { data: read } = await runtime.mail.app().message.read({ id: received.subject.id });
            expect(read.text).toBe(message.text);
            await runtime.owner.conversation.mark({
              target: { conversationId: read.conversationId, sourceFolderId: "Fol123" },
              read: true,
              idempotencyKey: "preview-only",
            });
          });
          await expect(runtime.__codeSdk.run(entrypoint, event)).rejects.toThrow("code_test_missing_mock");
          return {
            version: 1,
            mode: "simulate",
            ok: false,
            error: null,
            diagnostics: [],
            cases: [
              {
                name: fixture.name,
                file: null,
                ok: false,
                runs: [{ entrypoint, ok: false, error: bridge.failure(), value: null, calls: bridge.calls(), failures: [] }],
              },
            ],
          };
        },
      },
    );
    expect(result.cases[0]!.runs[0]!.calls.map((call) => call.operation)).toEqual(["mail.message.read", "mail.conversation.mark"]);
    expect(result.cases[0]!.runs[0]!.error).toBe("code_test_missing_mock");
    expect(effect).not.toHaveBeenCalled();
  } finally {
    effect.mockRestore();
  }
});
