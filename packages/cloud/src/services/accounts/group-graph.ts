/**
 * Graph work for the group relations view, on edges already read from the database.
 * Every walk is iterative and keeps a `seen` set, so cycles and long chains of nested groups stay safe.
 */

/** Outgoing neighbours of one group, in a stable order. */
export type Next = (id: string) => readonly string[];

/**
 * Strongly connected components that form a cycle: more than one group, or one group that contains itself.
 * Iterative Tarjan, so the data's depth never becomes call-stack depth.
 */
export const cycleComponents = (nodes: Iterable<string>, next: Next): string[][] => {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: { id: string; position: number }[] = [{ id: start, position: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const neighbours = next(top.id);
      if (top.position < neighbours.length) {
        const neighbour = neighbours[top.position]!;
        top.position += 1;
        if (!index.has(neighbour)) {
          index.set(neighbour, counter);
          low.set(neighbour, counter);
          counter += 1;
          stack.push(neighbour);
          onStack.add(neighbour);
          work.push({ id: neighbour, position: 0 });
        } else if (onStack.has(neighbour)) {
          low.set(top.id, Math.min(low.get(top.id)!, index.get(neighbour)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(top.id)!));
      if (low.get(top.id) !== index.get(top.id)) continue;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== top.id);
      if (component.length > 1 || next(component[0]!).includes(component[0]!)) cycles.push(component.reverse());
    }
  }
  return cycles;
};

/** Maps each group in a cycle to the position of its component. */
export const componentIndex = (components: readonly string[][]): Map<string, number> => {
  const of = new Map<string, number>();
  components.forEach((component, position) => {
    for (const id of component) of.set(id, position);
  });
  return of;
};

/** A real cycle through `id`: the shortest way back to it inside its component, as `[id, …, id]`. */
export const cycleWitness = (id: string, next: Next, componentOf: ReadonlyMap<string, number>): string[] => {
  const component = componentOf.get(id);
  if (component === undefined) return [];
  const previous = new Map<string, string>();
  const queue = [id];
  for (let position = 0; position < queue.length; position += 1) {
    const current = queue[position]!;
    for (const neighbour of next(current)) {
      if (neighbour === id) {
        const path = [current];
        while (path[0] !== id) path.unshift(previous.get(path[0]!)!);
        return [...path, id];
      }
      if (!previous.has(neighbour) && neighbour !== id && componentOf.get(neighbour) === component) {
        previous.set(neighbour, current);
        queue.push(neighbour);
      }
    }
  }
  return [];
};

export type RelationLevel = {
  /** Groups first reached on this level, with the group they were reached from. */
  items: { id: string; via: string }[];
  /** Edges from this level's source groups to groups that are already in the picture. */
  backs: { from: string; to: string }[];
};

/**
 * Levels outward from `focus`. A group already in the picture is never expanded again; an edge to it becomes a back edge.
 * Pass one `seen` set to both directions so each group appears once.
 */
export const relationLevels = (focus: string, depth: number, next: Next, seen: Set<string>): RelationLevel[] => {
  const levels: RelationLevel[] = [];
  let current = [focus];
  for (let level = 1; level <= depth && current.length > 0; level += 1) {
    const items: RelationLevel["items"] = [];
    const backs: RelationLevel["backs"] = [];
    const following: string[] = [];
    for (const id of current) {
      for (const neighbour of next(id)) {
        if (seen.has(neighbour)) {
          backs.push({ from: id, to: neighbour });
          continue;
        }
        seen.add(neighbour);
        items.push({ id: neighbour, via: id });
        following.push(neighbour);
      }
    }
    if (items.length === 0 && backs.length === 0) break;
    levels.push({ items, backs });
    current = following;
  }
  return levels;
};

/** Adjacency in both directions, each list ordered by the `order` of its groups. */
export const adjacency = (pairs: readonly (readonly [string, string])[], order: (left: string, right: string) => number) => {
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, value: string) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const [parent, child] of pairs) {
    add(children, parent, child);
    add(parents, child, parent);
  }
  for (const list of children.values()) list.sort(order);
  for (const list of parents.values()) list.sort(order);
  const empty: readonly string[] = [];
  return {
    nodes: new Set([...children.keys(), ...parents.keys()]),
    down: ((id) => children.get(id) ?? empty) satisfies Next,
    up: ((id) => parents.get(id) ?? empty) satisfies Next,
  };
};
