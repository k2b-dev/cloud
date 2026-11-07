import { createMemo, For, type JSX, untrack } from "solid-js";

type Entry<T> = { item: T; key: string; identity: string };

/**
 * `<For>` that keeps a row's element while its item stays the same: the same object, also when its getters change, or
 * a new object with the same identity (`by`). Hosts rebuild equal items whenever their inputs change; `<For>` would
 * then replace each row, and a row replaced between press and release swallows the click (#2140).
 * Each row reads its current item.
 */
export function KeyedFor<T>(props: {
  each: readonly T[];
  by: (item: T) => string;
  fallback?: JSX.Element;
  children: (item: () => T, index: () => number) => JSX.Element;
}): JSX.Element {
  let previous: Entry<T>[] = [];
  let counter = 0;
  const entries = createMemo(() => {
    const byObject = new Map(previous.map((entry) => [entry.item, entry.key]));
    const byIdentity = new Map<string, string[]>();
    for (const entry of previous) byIdentity.set(entry.identity, [...(byIdentity.get(entry.identity) ?? []), entry.key]);
    const used = new Set<string>();
    const next = props.each.map((item): Entry<T> => {
      // Only a new list reconciles rows; a getter behind the identity changing alone must not re-read the list.
      const identity = untrack(() => props.by(item));
      const same = byObject.get(item);
      const equal = byIdentity.get(identity)?.find((key) => !used.has(key));
      const key = same !== undefined && !used.has(same) ? same : (equal ?? `row-${counter++}`);
      used.add(key);
      return { item, key, identity };
    });
    previous = next;
    return next;
  });
  const byKey = createMemo(() => new Map(entries().map((entry) => [entry.key, entry.item])));
  return (
    <For each={entries().map((entry) => entry.key)} fallback={props.fallback}>
      {(key, index) => {
        const first = byKey().get(key)!;
        return props.children(() => byKey().get(key) ?? first, index);
      }}
    </For>
  );
}
