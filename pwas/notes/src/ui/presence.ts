import { createRoot, createSignal, onCleanup } from "solid-js";
import { presenceBatches } from "../lib/presence";
import { app } from "../state";

export type Person = { name: string; color: string };

const POLL_MS = 20_000;

/**
 * Who is writing in shared notes right now, for the live cards of the overview. It only reads
 * presence the server already has: asking never counts as a visit and never shows this browser.
 */
export const presence = createRoot(() => {
  const [people, setPeople] = createSignal<Record<string, Person[]>>({});
  let watchers = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;

  // One loop at most: a remount while a request is in flight must not start a second one.
  const poll = async () => {
    timer = undefined;
    if (polling) return;
    polling = true;
    const batches = presenceBatches(app.records());
    if (batches.length > 0 && app.online() && document.visibilityState === "visible") {
      const previous = people();
      const next: Record<string, Person[]> = {};
      for (const batch of batches) {
        // A batch that gets no answer keeps its last marks instead of flickering off.
        for (const entry of batch) next[entry.id] = previous[entry.id] ?? [];
        try {
          const response = await fetch("/api/presence", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ readIds: batch.map((entry) => entry.readId) }),
            credentials: "omit",
          });
          if (!response.ok) continue;
          const body: unknown = await response.json();
          for (const entry of batch)
            next[entry.id] = parsePeople(body && typeof body === "object" ? Reflect.get(body, entry.readId) : undefined);
        } catch {
          // Live marks are a hint; without them the cards show their date as usual.
        }
      }
      setPeople(next);
    }
    polling = false;
    if (watchers > 0 && !timer) timer = setTimeout(() => void poll(), POLL_MS);
  };

  return {
    of: (noteId: string) => people()[noteId] ?? [],
    /** Call inside a component that shows live marks; polling stops when the last one unmounts. */
    watch() {
      watchers += 1;
      if (watchers === 1 && !timer && !polling) void poll();
      onCleanup(() => {
        watchers -= 1;
        if (watchers === 0 && timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      });
    },
  };
});

function parsePeople(value: unknown): Person[] {
  if (!Array.isArray(value)) return [];
  const result: Person[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const name: unknown = Reflect.get(entry, "name");
    const color: unknown = Reflect.get(entry, "color");
    if (typeof name === "string" && typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color))
      result.push({ name: name.slice(0, 32), color });
  }
  return result.slice(0, 8);
}
