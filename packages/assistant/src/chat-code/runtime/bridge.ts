import { LIMITS } from "../contracts";
import { CloudError, cloudError } from "./errors";
export function createBridge(send: (message: unknown) => void) {
  let id = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  return {
    async rpc(method: string, args: unknown[] = [], signal?: AbortSignal): Promise<unknown> {
      if (signal?.aborted) throw new CloudError("cancelled", "The run was stopped.");
      if (pending.size >= LIMITS.pendingRequests)
        throw new CloudError("limit", "Too many pending host requests; await the current requests first.");
      return new Promise((resolve, reject) => {
        const requestId = id++;
        const clean = () => signal?.removeEventListener("abort", cancel);
        const cancel = () => {
          pending.delete(requestId);
          clean();
          send({ type: "cancel", id: requestId });
          reject(new CloudError("cancelled", "The request was cancelled."));
        };
        pending.set(requestId, {
          resolve: (value) => {
            clean();
            resolve(value);
          },
          reject: (error) => {
            clean();
            reject(cloudError(error));
          },
        });
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          send({ type: "rpc", id: requestId, method, args });
        } catch (error) {
          pending.delete(requestId);
          clean();
          reject(cloudError(error));
        }
      });
    },
    result(message: { id: number; value?: unknown; error?: string; code?: string }) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry?.reject(cloudError({ message: message.error, code: message.code }));
      else entry?.resolve(message.value);
    },
  };
}
