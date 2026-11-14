import type { TopicEvent } from "@k2b/sync";
import type { NotebookWorkspaceEvent } from "../src/lib/workspace-events";

/** Each socket receives the same committed invalidation, as with the real workspace topic. */
export const createWsInvalidations = () => {
  const listeners = new Set<(event: TopicEvent<NotebookWorkspaceEvent>) => void>();
  let sequence = 0;
  return {
    emit(
      data: NotebookWorkspaceEvent = {
        v: 1,
        type: "workspace.invalidated",
        notebookId: "test-notebook",
        reason: "permissions",
        scopes: ["permissions"],
      },
    ) {
      const n = ++sequence;
      for (const listener of listeners)
        listener({
          data,
          cursor: `s6t.events.${n}`,
          sequence: n,
          eventId: String(n),
          tenantId: data.notebookId,
          publishedAt: new Date("2026-11-12T12:00:00Z"),
        });
    },
    async *live({ signal }: { signal?: AbortSignal }) {
      const queue: TopicEvent<NotebookWorkspaceEvent>[] = [];
      let wake = () => {};
      const push = (event: TopicEvent<NotebookWorkspaceEvent>) => {
        queue.push(event);
        wake();
      };
      listeners.add(push);
      try {
        while (!signal?.aborted) {
          if (queue.length) yield queue.shift()!;
          else
            await new Promise<void>((resolve) => {
              const done = () => {
                signal?.removeEventListener("abort", done);
                resolve();
              };
              wake = done;
              signal?.addEventListener("abort", done, { once: true });
              if (signal?.aborted || queue.length) done();
            });
        }
      } finally {
        listeners.delete(push);
      }
    },
  };
};
