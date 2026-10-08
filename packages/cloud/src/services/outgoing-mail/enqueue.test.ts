import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  bindProcessApplicationId,
  clearProcessApplicationId,
  getProcessApplicationId,
  getProcessPlatformPermissions,
} from "../../_internal/process-identity";
import { audit } from "../audit";
import * as enqueue from "./enqueue";
import { mail } from "./index";
import { MailQuotaError } from "./messages";
import { OutgoingMailError } from "./store";

const message = { to: ["reader@example.org"], subject: "Hello", text: "Hello" };
let previousId: ReturnType<typeof getProcessApplicationId>;
let previousPermissions: ReturnType<typeof getProcessPlatformPermissions>;
beforeEach(() => {
  previousId = getProcessApplicationId();
  previousPermissions = getProcessPlatformPermissions();
  clearProcessApplicationId();
});
afterEach(() => {
  clearProcessApplicationId();
  if (previousId !== undefined) bindProcessApplicationId(previousId, previousPermissions);
});
test("enqueue requires startup and declaration, cancelling every stream on identity or validation failures", async () => {
  const record = spyOn(audit, "record").mockResolvedValue();
  const accept = spyOn(enqueue, "enqueueMail").mockResolvedValue({ batchId: "unused", ids: [] });
  const batch = () => {
    let cancelled = 0,
      pulls = 0;
    const messages = Array.from({ length: 2 }, () => ({
      ...message,
      attachments: [
        {
          filename: "a",
          contentType: "text/plain",
          content: new ReadableStream<Uint8Array>(
            {
              pull() {
                pulls++;
              },
              cancel() {
                cancelled++;
              },
            },
            { highWaterMark: 0 },
          ),
        },
      ],
    }));
    return { messages, count: () => ({ cancelled, pulls }) };
  };
  try {
    let input = batch();
    expect(await mail.enqueue(input.messages)).toMatchObject({ ok: false, error: { code: "mail_unavailable" } });
    expect(input.count()).toEqual({ cancelled: 2, pulls: 0 });
    bindProcessApplicationId("inventory");
    input = batch();
    expect(await mail.enqueue(input.messages)).toMatchObject({ ok: false, error: { code: "mail_not_declared" } });
    expect(input.count()).toEqual({ cancelled: 2, pulls: 0 });
    clearProcessApplicationId();
    bindProcessApplicationId("inventory", ["mail:send"]);
    input = batch();
    input.messages[1]!.to = [];
    expect(await mail.enqueue(input.messages)).toMatchObject({ ok: false, error: { code: "bad_input" } });
    expect(input.count()).toEqual({ cancelled: 2, pulls: 0 });
    expect(accept).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(record.mock.calls)).not.toContain(message.to[0]!);
  } finally {
    record.mockRestore();
    accept.mockRestore();
  }
});
test("enqueue delegates process identity, preserves quota and backlog details, and returns an audited failure after an uncertain commit", async () => {
  bindProcessApplicationId("inventory", ["mail:send"]);
  const accepted = { batchId: crypto.randomUUID(), ids: [crypto.randomUUID()] };
  const accept = spyOn(enqueue, "enqueueMail").mockResolvedValue(accepted);
  const record = spyOn(audit, "record").mockResolvedValue();
  try {
    expect(await mail.enqueue([message])).toEqual({ ok: true, data: accepted });
    expect(accept).toHaveBeenCalledWith("inventory", [message]);
    accept.mockRejectedValue(new MailQuotaError(10, 9, 2));
    expect(await mail.enqueue([message])).toMatchObject({ ok: false, error: { code: "quota_exceeded", limit: 10, used: 9, requested: 2 } });
    accept.mockRejectedValue(new OutgoingMailError("backlog_full", "Queue full.", 409));
    expect(await mail.enqueue([message])).toMatchObject({ ok: false, error: { code: "backlog_full", status: 409 } });
    accept.mockRejectedValue(new enqueue.MailAcceptanceUnknown());
    expect(await mail.enqueue([message])).toMatchObject({
      ok: false,
      error: { code: "mail_unavailable", status: 500, message: expect.stringContaining("Retry with the same keys") },
    });
    expect(record).toHaveBeenCalledTimes(3);
    expect(record.mock.calls[2]?.[0]).toMatchObject({ outcome: "denied", error: { code: "mail_unavailable" } });
  } finally {
    accept.mockRestore();
    record.mockRestore();
  }
});
