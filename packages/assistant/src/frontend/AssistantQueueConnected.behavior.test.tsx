import { afterEach, expect, spyOn, test } from "bun:test";
import type { AiDraftContentPart } from "@k2b/cloud/ai";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { assistantApi } from "../api/client";
import type { AssistantQueueEntry } from "./AssistantQueue";
import type { AssistantQueueHost } from "./AssistantQueueConnected";

const bootstrap = createDomTestHarness();
const { LocaleProvider, prompts } = await import("@k2b/ui");
const { default: AssistantQueueConnected } = await import("./AssistantQueueConnected");
bootstrap.cleanup();

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
});

const own: AssistantQueueEntry = {
  id: "q1",
  text: "Und markiere die Buchungen über 300 €",
  origin: { kind: "person", id: "u1", name: "Lena Vogt" },
  state: "pending",
  authorIsViewer: true,
};
const automation: AssistantQueueEntry = {
  id: "q2",
  text: "Briefing für Montag",
  origin: { kind: "automation", id: "a1", name: "Morgen-Briefing" },
  state: "pending",
  authorIsViewer: false,
};
const content: AiDraftContentPart[] = [{ type: "text", text: own.text }];
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

/** The queue as the chat mounts it, with a host that records what the queue asks of the chat. */
const mount = (options: { draft?: boolean } = {}) => {
  const dom = createDomTestHarness();
  cleanup.push(dom.cleanup);
  const calls: string[] = [];
  const [entries, setEntries] = createSignal<readonly AssistantQueueEntry[]>([own, automation]);
  const [sendingId, setSendingId] = createSignal<string | null>(null);
  const [failedIds, setFailedIds] = createSignal<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = createSignal(false);
  const host: AssistantQueueHost = {
    conversationId: () => "chat01",
    content: (id) => (id === own.id ? content : undefined),
    reload: async () => {
      calls.push("reload");
    },
    hasDraft: () => options.draft ?? false,
    putIntoField: (id, parts) => calls.push(`field:${id}:${parts.map((part) => (part.type === "text" ? part.text : "")).join("")}`),
    fail: (message) => calls.push(`fail:${message}`),
    sendingId,
    setSendingId,
    failedIds,
    setFailedIds,
    busy,
    setBusy,
  };
  cleanup.push(
    render(
      () => (
        <LocaleProvider locale="de">
          <AssistantQueueConnected host={host} entries={entries()} layout="line" />
        </LocaleProvider>
      ),
      dom.root,
    ),
  );
  const button = (id: string, name: string) =>
    dom.root.querySelector<HTMLButtonElement>(`[data-entry="${id}"] button[aria-label="${name}"]`)!;
  return { dom, calls, button, sendingId, failedIds, busy, setEntries };
};

test("Send now holds the ring until Cloud answers, then reads the queue again", async () => {
  let answer: (value: { id: string; state: "submitted"; turnId: string }) => void = () => {};
  const send = spyOn(assistantApi, "sendQueuedMessageNow").mockImplementation(
    () => new Promise((resolve) => (answer = resolve as typeof answer)) as never,
  );
  cleanup.push(() => send.mockRestore());
  const { button, sendingId, calls, dom } = mount();
  button("q2", "Jetzt senden").click();
  expect(send).toHaveBeenCalledWith("chat01", "q2");
  expect(sendingId()).toBe("q2");
  expect(dom.root.querySelector('[data-entry="q2"] [role="status"]')).not.toBeNull();
  answer({ id: "q2", state: "submitted", turnId: "t1" });
  await flush();
  expect(sendingId()).toBeNull();
  expect(calls).toEqual(["reload"]);
});

test("a lost answer asks for the receipt; an entry Cloud did not send offers Send again", async () => {
  const send = spyOn(assistantApi, "sendQueuedMessageNow").mockRejectedValue(new Error("network"));
  const receipt = spyOn(assistantApi, "queuedMessageSendReceipt").mockResolvedValue({ id: "q1", state: "failed", turnId: null } as never);
  cleanup.push(
    () => send.mockRestore(),
    () => receipt.mockRestore(),
  );
  const { button, failedIds } = mount();
  button("q1", "Jetzt senden").click();
  await flush();
  expect(receipt).toHaveBeenCalledWith("chat01", "q1");
  expect([...failedIds()]).toEqual(["q1"]);
  expect(button("q1", "Erneut senden")).not.toBeNull();
});

test("Remove takes an entry out for everyone's entries and reads the queue again; a failure is reported", async () => {
  const cancel = spyOn(assistantApi, "cancelQueuedMessage")
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("Nicht erlaubt."));
  cleanup.push(() => cancel.mockRestore());
  const { button, calls, busy } = mount();
  button("q2", "Entfernen").click();
  await flush();
  expect(cancel).toHaveBeenCalledWith("chat01", "q2");
  expect(calls).toEqual(["reload"]);
  button("q2", "Entfernen").click();
  await flush();
  expect(calls).toEqual(["reload", "fail:Nicht erlaubt."]);
  expect(busy()).toBe(false);
});

test("Edit moves one's own entry into the field, and asks first when the field holds a draft", async () => {
  const cancel = spyOn(assistantApi, "cancelQueuedMessage").mockResolvedValue(undefined);
  const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
  cleanup.push(
    () => cancel.mockRestore(),
    () => confirm.mockRestore(),
  );
  const withDraft = mount({ draft: true });
  withDraft.button("q1", "Bearbeiten").click();
  await flush();
  // Declined: the entry stays queued and the draft stays.
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
  expect(withDraft.calls).toEqual([]);

  const empty = mount();
  empty.button("q1", "Bearbeiten").click();
  await flush();
  expect(cancel).toHaveBeenCalledWith("chat01", "q1");
  expect(empty.calls).toEqual([`field:chat01:${own.text}`, "reload"]);
});
