import type { AiFrontendToolHandler } from "@k2b/cloud/ai/solid";
import type { CapabilityDecision, CodeApproval } from "../artifacts/runtime/capabilities";

type Call = Parameters<AiFrontendToolHandler>[0];
export type HostRequest =
  | { operation: "start"; origin: string; token: string }
  | { operation: "health" }
  | { operation: "close" }
  | { operation: "execute" | "call"; call: Call }
  | { operation: "approve"; approval: CodeApproval }
  | { operation: "progress"; step: string };
export type HostResult = Awaited<ReturnType<AiFrontendToolHandler>> | CapabilityDecision | null;
type Message =
  | { id: number; cancel: true }
  | { id: number; request: HostRequest }
  | { id: number; result: HostResult; error?: never }
  | { id: number; error: string };

/** Private IPC between our CLI and its browser subprocess; never user code. */
export function hostIpc(send: (message: Message) => void, handle: (request: HostRequest, signal: AbortSignal) => Promise<HostResult>) {
  let sequence = 0;
  let closed: Error | undefined;
  const active = new Map<number, AbortController>();
  const pending = new Map<number, { resolve: (value: HostResult) => void; reject: (error: Error) => void }>();
  const close = (error = new Error("CLI browser host closed; no operation was replayed")) => {
    closed = error;
    for (const controller of active.values()) controller.abort();
    active.clear();
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  return {
    request(request: HostRequest, signal?: AbortSignal): Promise<HostResult> {
      if (signal?.aborted) return Promise.reject(new DOMException("Request cancelled", "AbortError"));
      if (closed) return Promise.reject(closed);
      return new Promise((resolve, reject) => {
        const id = sequence++;
        // Checks acknowledge cancellation only after their pages and copies
        // are gone. Other operations retain their immediate IPC cancellation.
        const waitForCleanup = (request.operation === "execute" || request.operation === "call") && request.call.name === "code_check";
        const cancelled = () => new DOMException("Request cancelled", "AbortError");
        const cancel = () => {
          send({ id, cancel: true });
          if (!waitForCleanup) {
            pending.delete(id);
            reject(cancelled());
          }
        };
        const clean = () => signal?.removeEventListener("abort", cancel);
        pending.set(id, {
          resolve: (value) => {
            clean();
            if (signal?.aborted) reject(cancelled());
            else resolve(value);
          },
          reject: (error) => {
            clean();
            reject(signal?.aborted ? cancelled() : error);
          },
        });
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          send({ id, request });
        } catch (error) {
          pending.delete(id);
          clean();
          reject(error);
        }
      });
    },
    receive(message: Message) {
      if (closed) return;
      if ("cancel" in message) {
        active.get(message.id)?.abort();
      } else if ("request" in message) {
        const controller = new AbortController();
        active.set(message.id, controller);
        void handle(message.request, controller.signal)
          .then(
            (result) => {
              if (!closed) send({ id: message.id, result });
            },
            (error) => {
              if (!closed) send({ id: message.id, error: error instanceof Error ? error.message : String(error) });
            },
          )
          .finally(() => active.delete(message.id))
          .catch((error) => close(error instanceof Error ? error : new Error(String(error))));
      } else {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if ("error" in message) entry?.reject(new Error(message.error));
        else entry?.resolve(message.result);
      }
    },
    close,
  };
}
