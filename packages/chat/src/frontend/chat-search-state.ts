import { importOnDemand } from "@k2b/cloud/browser/reload";
import { type Accessor, createEffect, createSignal, on, onCleanup } from "solid-js";
import type { SearchResult } from "./search-api";

/** Typing pauses this long before the list asks; each new letter cancels the question before it. */
const SEARCH_DELAY_MS = 200;

/**
 * One search for the whole list, however many places show it (the sidebar and the phone's list page): it asks once
 * per pause in typing, cancels the question before, and keeps the last answer while the next one loads.
 */
export const createChatSearch = (query: Accessor<string>) => {
  const [settled, setSettled] = createSignal("");
  createEffect(
    on(query, (next) => {
      if (!next) return setSettled("");
      const timer = setTimeout(() => setSettled(next), SEARCH_DELAY_MS);
      onCleanup(() => clearTimeout(timer));
    }),
  );
  const [attempt, setAttempt] = createSignal(0);
  const [answer, setAnswer] = createSignal<{ q: string; result: SearchResult } | null>(null);
  const [status, setStatus] = createSignal<"loading" | "ready" | "failed">("loading");
  createEffect(
    on([settled, attempt], ([q]) => {
      if (!q) {
        setAnswer(null);
        setStatus("loading");
        return;
      }
      const request = new AbortController();
      onCleanup(() => request.abort());
      setStatus("loading");
      importOnDemand(() => import("./search-api"))
        .then((module) => {
          if (!module) throw new Error("Search code could not load");
          return module.createSearchApi().search(q, request.signal);
        })
        .then(
          (result) => {
            setAnswer({ q, result });
            setStatus("ready");
          },
          () => {
            if (!request.signal.aborted) setStatus("failed");
          },
        );
    }),
  );
  return {
    answer,
    /** "loading" also while the reader is still typing, so a stale "nothing found" never stands for the new text. */
    status: () => (query() !== settled() ? "loading" : status()),
    /** Asks again with the same text, after a failure or an action that changed a hit. */
    retry: () => setAttempt((value) => value + 1),
  };
};
export type ChatSearchState = ReturnType<typeof createChatSearch>;
