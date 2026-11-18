import type { CodePageLinks } from "@k2b/cloud/contracts/code-routes";
import { createSignal, onCleanup, untrack } from "solid-js";
import { isServer } from "solid-js/web";
import type { CodeVersionCardEntry, CodeVersionCardRef } from "../code-version-cards";
import type { AssistantLiveHub } from "./assistant-live";
import type { CodeVersionCardLoaded } from "./code-version-card-state";

type Entry = CodeVersionCardLoaded | "denied" | "failed";
const key = (ref: CodeVersionCardRef) => `${ref.codeId}:${ref.versionId}`;
const loaded = (entry: CodeVersionCardEntry, pages?: CodePageLinks): Entry => {
  if (entry.state !== "available") return entry.state;
  const snapshot = entry.snapshot;
  return {
    ...snapshot,
    pages: snapshot.pages === undefined ? (pages ?? null) : snapshot.pages,
    preview: { ...snapshot.preview, place: null },
    review: snapshot.review ? { ...snapshot.review, comments: [], decidedAt: null, activeVersion: null } : null,
  };
};

/** One view owns one batch loader, one invalidator and one immutable page projection per Code/version. */
export function createCodeVersionCardStore(live: AssistantLiveHub, initial: readonly CodeVersionCardEntry[] = []) {
  const [entries, setEntries] = createSignal<Record<string, Entry>>(Object.fromEntries(initial.map((item) => [key(item), loaded(item)])));
  const refs = new Map<string, { ref: CodeVersionCardRef; count: number }>();
  const pages = new Map<string, CodePageLinks>();
  const queued = new Map<string, CodeVersionCardRef>();
  const revisions = new Map<string, number>();
  let disposed = false,
    scheduled = false;
  for (const item of initial) if (item.state === "available" && item.snapshot.pages) pages.set(key(item), item.snapshot.pages);
  onCleanup(() => {
    disposed = true;
  });
  let newest: Promise<boolean> = Promise.resolve(true);
  const refresh = (versions: readonly CodeVersionCardRef[]): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      if (!versions.length || disposed) return true;
      const batch = [...new Map(versions.map((ref) => [key(ref), ref])).values()];
      for (const ref of batch) queued.delete(key(ref));
      const generations = new Map(
        batch.map((ref) => {
          const id = key(ref),
            revision = (revisions.get(id) ?? 0) + 1;
          revisions.set(id, revision);
          return [id, revision];
        }),
      );
      const answers: CodeVersionCardEntry[] = await (async () => {
        const [{ loadCodeVersionCards }, { browserCodeInvoke }] = await Promise.all([
          import("../code-version-cards"),
          import("./code-client"),
        ]);
        return loadCodeVersionCards(
          browserCodeInvoke,
          batch,
          batch.filter((ref) => pages.has(key(ref))).map((ref) => ref.versionId),
        );
      })().catch(() => batch.map((ref) => ({ ...ref, state: "failed" as const })));
      if (disposed) return false;
      let ok = true,
        superseded = false;
      for (const answer of answers) {
        const id = key(answer);
        if (!refs.has(id)) continue;
        if (generations.get(id) !== revisions.get(id)) {
          superseded = true;
          continue;
        }
        if (answer.state === "failed") {
          ok = false;
          const previous = entries()[id];
          setEntries((current) => ({ ...current, [id]: typeof previous === "object" ? { ...previous, refreshFailed: true } : "failed" }));
          continue;
        }
        const value = loaded(answer, pages.get(id));
        if (typeof value === "object" && value.pages === null) {
          value.refreshFailed = true;
          ok = false;
        }
        if (typeof value === "object" && value.pages) pages.set(id, value.pages);
        else pages.delete(id);
        setEntries((current) => ({ ...current, [id]: value }));
      }
      return superseded ? (await newest) && ok : ok;
    };
    const pending = run();
    newest = pending;
    return pending;
  };
  const queue = (ref: CodeVersionCardRef) => {
    queued.set(key(ref), ref);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const batch = [...queued.values()];
      queued.clear();
      if (!disposed) void refresh(batch);
    });
  };
  onCleanup(
    live.register({
      matches: (event) =>
        event.domains.has("code-versions") && [...refs.values()].some(({ ref }) => !event.codeIds || event.codeIds.has(ref.codeId)),
      invalidate: async (event) => {
        const affected = [...refs.values()].filter(({ ref }) => !event.codeIds || event.codeIds.has(ref.codeId)).map(({ ref }) => ref);
        if (!(await refresh(affected))) throw new Error("Code version cards could not be read again.");
      },
    }),
  );
  return {
    read: (ref: CodeVersionCardRef) => entries()[key(ref)] ?? null,
    refresh: (ref: CodeVersionCardRef) => refresh([ref]),
    retain(ref: CodeVersionCardRef) {
      const id = key(ref),
        current = refs.get(id);
      refs.set(id, { ref, count: (current?.count ?? 0) + 1 });
      if (!isServer && untrack(() => entries()[id]) === undefined) queue(ref);
      let retained = true;
      return () => {
        if (!retained) return;
        retained = false;
        const held = refs.get(id);
        if (held && held.count > 1) refs.set(id, { ...held, count: held.count - 1 });
        else {
          refs.delete(id);
          if (!isServer) {
            pages.delete(id);
            setEntries((current) => {
              const next = { ...current };
              delete next[id];
              return next;
            });
          }
        }
      };
    },
  };
}
export type CodeVersionCardStore = ReturnType<typeof createCodeVersionCardStore>;
