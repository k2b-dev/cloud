import { createRoot, createSignal, onCleanup } from "solid-js";
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

  const poll = async () => {
    timer = undefined;
    const shared = app.records().flatMap((record) => (record.share ? [{ id: record.id, readId: record.share.readId }] : []));
    if (shared.length > 0 && app.online() && document.visibilityState === "visible") {
      try {
        const response = await fetch("/api/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ readIds: shared.map((entry) => entry.readId) }),
          credentials: "omit",
        });
        if (response.ok) {
          const body: unknown = await response.json();
          const next: Record<string, Person[]> = {};
          for (const entry of shared)
            next[entry.id] = parsePeople(body && typeof body === "object" ? Reflect.get(body, entry.readId) : undefined);
          setPeople(next);
        }
      } catch {
        // Live marks are a hint; without them the cards show their date as usual.
      }
    }
    if (watchers > 0) timer = setTimeout(() => void poll(), POLL_MS);
  };

  return {
    of: (noteId: string) => people()[noteId] ?? [],
    /** Call inside a component that shows live marks; polling stops when the last one unmounts. */
    watch() {
      watchers += 1;
      if (watchers === 1) void poll();
      onCleanup(() => {
        watchers -= 1;
        if (watchers === 0 && timer) clearTimeout(timer);
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
