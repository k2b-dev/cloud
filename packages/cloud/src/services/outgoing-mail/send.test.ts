import { expect, spyOn, test } from "bun:test";
import type { MailRecord } from "../../contracts/outgoing-mail";
import { outgoingMailMessages } from "./messages";
import { waitForMail } from "./send";
import * as sync from "./sync";

const queued: MailRecord = {
  appId: "inventory",
  id: crypto.randomUUID(),
  profile: "alerts",
  to: ["reader@example.org"],
  subject: "Hello",
  attachments: [],
  status: "queued",
  failures: [],
  attempts: 0,
  createdAt: new Date().toISOString(),
};
test("aborting the wait returns a recorded snapshot even if a database read stalls", async () => {
  const read = spyOn(outgoingMailMessages, "read").mockImplementation(() => new Promise(() => {}));
  const topic = spyOn(sync, "mailSettled").mockImplementation(() => {
    throw new Error("Sync is unavailable");
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    expect(await waitForMail("inventory", queued, controller.signal)).toEqual(queued);
  } finally {
    clearTimeout(timer);
    read.mockRestore();
    topic.mockRestore();
  }
}, 200);
