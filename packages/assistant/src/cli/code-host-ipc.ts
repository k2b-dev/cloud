import type { CodeApproval, CapabilityDecision } from "../artifacts/runtime/capabilities";
import type { AiFrontendToolHandler } from "@k2b/cloud/ai/solid";

type Call = Parameters<AiFrontendToolHandler>[0];
export type HostRequest =
  | { operation: "start" }
  | { operation: "health" }
  | { operation: "close" }
  | { operation: "execute" | "call"; call: Call }
  | { operation: "fetch"; path: string; method: string; headers: Record<string, string>; body: ArrayBuffer | null }
  | { operation: "approve"; approval: CodeApproval };
export type HostResponse = { status: number; headers: Record<string, string>; body: ArrayBuffer };
export type HostResult = Awaited<ReturnType<AiFrontendToolHandler>> | HostResponse | CapabilityDecision | null;
type Message = { id: number; cancel: true } | { id: number; request: HostRequest } | { id: number; result: HostResult; error?: never } | { id: number; error: string };

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
        const cancel = () => {
          pending.delete(id);
          send({ id, cancel: true });
          reject(new DOMException("Request cancelled", "AbortError"));
        };
        const clean = () => signal?.removeEventListener("abort", cancel);
        pending.set(id, { resolve: value => { clean(); resolve(value); }, reject: error => { clean(); reject(error); } });
        signal?.addEventListener("abort", cancel, { once: true });
        try { send({ id, request }); } catch (error) { pending.delete(id); clean(); reject(error); }
      });
    },
    receive(message: Message) {
      if (closed) return;
      if ("cancel" in message) { active.get(message.id)?.abort(); }
      else if ("request" in message) {
        const controller = new AbortController();
        active.set(message.id, controller);
        void handle(message.request, controller.signal).then(
          result => { if (!closed) send({ id: message.id, result }); },
          error => { if (!closed) send({ id: message.id, error: error instanceof Error ? error.message : String(error) }); },
        ).finally(() => active.delete(message.id)).catch(error => close(error instanceof Error ? error : new Error(String(error))));
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

export function hostHeaders(input: HeadersInit = {}): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(input).forEach((value, key) => { result[key] = value; });
  return result;
}
