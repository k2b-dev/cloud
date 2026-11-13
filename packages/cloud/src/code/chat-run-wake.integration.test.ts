import { afterAll, beforeAll, expect, jest, spyOn, test } from "bun:test";
import { connectTestNats, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { getProcessNats, startProcessSync } from "../_internal/process-sync";
import { workWakeSubject } from "../_internal/work-wake";
import { connections } from "../runtime/connections";
import { CHAT_RUN_FALLBACK_MS, notifyChatRun, openChatRunWake } from "./chat-run-wake";

suiteFor("nats")("chat run NATS wakeups", () => {
  let runtime: Awaited<ReturnType<typeof startProcessSync>>;
  let remote: Awaited<ReturnType<typeof connectTestNats>>;
  const job = "11111111-1111-4111-8111-111111111111";
  beforeAll(async () => {
    runtime = await startProcessSync({ application: "core" });
    remote = await connectTestNats();
  });
  afterAll(async () => {
    await remote.close();
    await runtime.stop();
  });
  test("opening never waits for a broker flush, so cancellation remains available", async () => {
    const blocked = Promise.withResolvers<void>();
    const flush = spyOn(getProcessNats(), "flush").mockImplementation(() => blocked.promise);
    const controller = new AbortController();
    const opening = Promise.resolve(openChatRunWake(job, "mailbox", controller.signal));
    try {
      expect(flush).not.toHaveBeenCalled();
      controller.abort();
      const wake = await opening;
      await wake.wait();
      wake.close();
    } finally {
      blocked.resolve();
      flush.mockRestore();
      (await opening).close();
    }
  });
  test("another replica wakes only its job and channel, and status wakes both mailbox and call", async () => {
    const controller = new AbortController();
    const mailbox = await openChatRunWake(job, "mailbox", controller.signal);
    const call = await openChatRunWake(job, "call-id", controller.signal);
    const subject = workWakeSubject(connections().nats.namespace, `code-chat:${job}`);
    try {
      let woke = false;
      const waiting = mailbox.wait().then(() => {
        woke = true;
      });
      remote.publish(subject, "other-call");
      notifyChatRun("22222222-2222-4222-8222-222222222222", "mailbox");
      await remote.flush();
      await getProcessNats().flush();
      expect(woke).toBe(false);
      remote.publish(subject, "mailbox");
      await waiting;
      const nextMailbox = mailbox.wait();
      const nextCall = call.wait();
      remote.publish(subject, "status");
      await Promise.all([nextMailbox, nextCall]);
    } finally {
      controller.abort();
      mailbox.close();
      call.close();
    }
  });
  test("hints coalesce before waiting and an abort closes a pending wait", async () => {
    const controller = new AbortController();
    const wake = await openChatRunWake(job, "mailbox", controller.signal);
    try {
      for (let i = 0; i < 50; i++) notifyChatRun(job, "mailbox");
      await getProcessNats().flush();
      await wake.wait();
      let finished = false;
      const waiting = wake.wait().then(() => {
        finished = true;
      });
      await Promise.resolve();
      expect(finished).toBe(false);
      controller.abort();
      await waiting;
      expect(finished).toBe(true);
    } finally {
      wake.close();
    }
  });
  test("closing and reopening a connection recovers with a slow fallback when the hint was lost", async () => {
    expect(CHAT_RUN_FALLBACK_MS).toBeGreaterThanOrEqual(2_000);
    const controller = new AbortController();
    const old = await openChatRunWake(job, "mailbox", controller.signal);
    old.close();
    notifyChatRun(job, "mailbox");
    await getProcessNats().flush();
    const replacement = await openChatRunWake(job, "mailbox", controller.signal);
    try {
      jest.useFakeTimers();
      let finished = false;
      const waiting = replacement.wait().then(() => {
        finished = true;
      });
      jest.advanceTimersByTime(1_999);
      await Promise.resolve();
      expect(finished).toBe(false);
      jest.advanceTimersByTime(1);
      await waiting;
      expect(finished).toBe(true);
    } finally {
      replacement.close();
      jest.useRealTimers();
    }
  });
});
