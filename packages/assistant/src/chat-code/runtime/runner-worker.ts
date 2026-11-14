import { ChatRunReplySchema, decodeChatValue, encodeChatValue } from "@k2b/cloud/code/chat-run";
import type { RunnerJsonValue } from "@k2b/cloud/code/runner";
import { LIMITS } from "../contracts";

type Host = { call: (operation: string, input: RunnerJsonValue) => Promise<RunnerJsonValue> };
let host: Host;
let receive: ((event: { data: unknown }) => void) | undefined;
let finish: () => void;
const finished = new Promise<void>((resolve) => {
  finish = resolve;
});
let connected: () => void;
const connection = new Promise<void>((resolve) => {
  connected = resolve;
});
let tail = Promise.resolve();
let failure: unknown;
let queued = 0;

// The existing script runtime remains a dedicated-worker protocol. Its runner adapter uses only
// the workerd binding; no DOM, browser worker, HTTP credentials, or network access is introduced.
Object.defineProperty(globalThis, "addEventListener", {
  value: (name: string, listener: typeof receive) => {
    if (name === "message") receive = listener;
  },
});
Object.defineProperty(globalThis, "postMessage", {
  value: (message: { type: string; id?: number }) => {
    if (++queued > LIMITS.pendingRequests) {
      failure = new Error("Too many pending host messages; await current work before sending more.");
      finish();
      return;
    }
    const deliver = async () => {
      await connection;
      const reply = ChatRunReplySchema.parse(await host.call("chat.message", await encodeChatValue(message)));
      if (message.type === "rpc") {
        receive?.({
          data: reply.ok
            ? { type: "result", id: message.id, value: decodeChatValue(reply.value) }
            : { type: "result", id: message.id, error: reply.error.message, code: reply.error.code },
        });
      } else if (!reply.ok) throw new Error(reply.error.message);
      if (message.type === "ready" || message.type === "error") finish();
    };
    // Bound parallel host traffic with the runtime's existing pending-request ceiling.
    tail = tail
      .then(deliver)
      .catch((error) => {
        failure = error;
        finish();
      })
      .finally(() => {
        queued--;
      });
  },
});

export async function run(input: { context: unknown; files: unknown }, cloud: Host) {
  host = cloud;
  connected();
  const boot = Reflect.get(globalThis, "__artifactBoot");
  if (typeof boot !== "function") throw new Error("code_chat_runtime_missing");
  boot();
  const init = Reflect.get(globalThis, "__artifactInit");
  if (typeof init !== "function") throw new Error("code_chat_runtime_missing");
  init(input.context, input.files);
  const execute = Reflect.get(globalThis, "__artifactExecute");
  if (typeof execute !== "function") throw new Error("code_chat_runtime_missing");
  execute();
  await finished;
  await tail;
  if (failure) throw failure;
}
