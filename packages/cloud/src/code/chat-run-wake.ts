import { getProcessNats } from "../_internal/process-sync";
import { workWakeSubject } from "../_internal/work-wake";
import { connections } from "../runtime/connections";
import { logger } from "../services/logging";

/** Private chat-run bridge hints. Postgres remains the delivery/lease authority. */
export const CHAT_RUN_FALLBACK_MS = 2_000;
const log = logger("code:chat-run-wake");
const subject = (jobId: string) => workWakeSubject(connections().nats.namespace, `code-chat:${jobId}`);

/** Call after commit; a lost hint is repaired by the slow fallback. No payload or authority crosses NATS. */
export function notifyChatRun(jobId: string, channel: string): void {
  try {
    getProcessNats().publish(subject(jobId), channel);
  } catch {
    log.warn("Chat runner notification unavailable; slow fallback will recover");
  }
}

/** One coalesced hint per waiter, on the existing process-owned NATS connection. */
export function openChatRunWake(jobId: string, channel: string, signal: AbortSignal) {
  let pending = false;
  let finish: (() => void) | undefined;
  let unsubscribe = () => {};
  let closed = false;
  try {
    const connection = getProcessNats();
    const subscription = connection.subscribe(subject(jobId), {
      callback: (error, message) => {
        if (error) {
          log.warn("Chat runner subscription unavailable; slow fallback will recover");
        } else if (message.string() === channel || message.string() === "status") {
          pending = true;
          finish?.();
        }
      },
    });
    unsubscribe = () => subscription.unsubscribe();
    // Do not wait for broker acknowledgement: a half-open connection must not
    // delay admission or cancellation. The fallback covers subscription races.
  } catch {
    unsubscribe();
    log.warn("Chat runner subscription unavailable; slow fallback will recover");
  }
  const close = () => {
    closed = true;
    unsubscribe();
    finish?.();
    signal.removeEventListener("abort", close);
  };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();
  return {
    wait: () => {
      if (closed || pending) {
        pending = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => finish?.(), CHAT_RUN_FALLBACK_MS);
        finish = () => {
          clearTimeout(timer);
          finish = undefined;
          pending = false;
          resolve();
        };
      });
    },
    close,
  };
}
