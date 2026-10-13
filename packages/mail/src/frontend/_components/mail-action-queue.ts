import { MAIL_BULK_CONCURRENCY } from "./mail-bulk-actions";

/** Submission order belongs to a conversation; unrelated conversations share the worker budget. */
export const createMailActionQueue = (concurrency = MAIL_BULK_CONCURRENCY) => {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Mail action concurrency must be a positive integer");
  const waiting: { conversationId: string; start: () => void }[] = [];
  const active = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const drain = () => {
    while (active.size < concurrency) {
      const index = waiting.findIndex((job) => !active.has(job.conversationId));
      if (index < 0) break;
      const job = waiting.splice(index, 1)[0]!;
      active.add(job.conversationId);
      job.start();
    }
    notify();
  };
  return {
    enqueue<T>(conversationId: string, job: () => Promise<T>) {
      let started = false;
      let cancelled = false;
      let resolve!: (value: { ran: true; value: T } | { ran: false }) => void;
      let reject!: (error: unknown) => void;
      const result = new Promise<{ ran: true; value: T } | { ran: false }>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const entry = {
        conversationId,
        start: () => {
          started = true;
          void (async () => {
            try {
              resolve({ ran: true, value: await job() });
            } catch (error) {
              reject(error);
            } finally {
              active.delete(conversationId);
              drain();
            }
          })();
        },
      };
      waiting.push(entry);
      drain();
      return {
        result,
        cancel: () => {
          if (started || cancelled) return false;
          cancelled = true;
          waiting.splice(waiting.indexOf(entry), 1);
          resolve({ ran: false });
          drain();
          return true;
        },
      };
    },
    size: () => waiting.length + active.size,
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export type MailActionQueue = ReturnType<typeof createMailActionQueue>;
