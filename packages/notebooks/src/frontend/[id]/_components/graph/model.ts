import { compareNoteOrder } from "../../../../lib/note-order";
import type { GraphNode, NoteGraph } from "../../../../service/links";

export const TOP_LEVEL_AREA = "top";
export type GraphArea = { key: string; index: number; slot: number; title: string | null; count: number };
export type GraphNote = {
  id: string;
  title: string;
  parentId: string | null;
  updatedAt: string;
  area: GraphArea;
  order: number;
  depth: number;
  out: ReadonlySet<string>;
  in: ReadonlySet<string>;
  neighbours: ReadonlySet<string>;
  deg: number;
  orphan: boolean;
};
export type GraphModelEdge = { source: string; target: string; sameArea: boolean };
export type GraphModel = {
  notes: readonly GraphNote[];
  byId: ReadonlyMap<string, GraphNote>;
  edges: readonly GraphModelEdge[];
  areas: readonly GraphArea[];
};

/** Builds the graph model; siblings follow the notebook order of the sidebar and the Book in the reader's `locale`. */
export function buildGraphModel(graph: NoteGraph, locale: string): GraphModel {
  const source = new Map(graph.nodes.map((node) => [node.id, node]));
  const parents = new Map(graph.nodes.map((node) => [node.id, node.parentId && source.has(node.parentId) ? node.parentId : null]));
  // Each cycle member becomes a root; branches attached to it keep their parent.
  const checked = new Set<string>();
  for (const node of graph.nodes) {
    const path: string[] = [];
    const at = new Map<string, number>();
    let id: string | null = node.id;
    while (id !== null && !checked.has(id)) {
      const cycleStart = at.get(id);
      if (cycleStart !== undefined) {
        for (const member of path.slice(cycleStart)) parents.set(member, null);
        break;
      }
      at.set(id, path.length);
      path.push(id);
      id = parents.get(id) ?? null;
    }
    for (const member of path) checked.add(member);
  }
  const children = new Map<string | null, GraphNode[]>();
  for (const node of graph.nodes) {
    const parent = parents.get(node.id) ?? null;
    const siblings = children.get(parent) ?? [];
    siblings.push(node);
    children.set(parent, siblings);
  }
  const compare = compareNoteOrder(locale, (node: GraphNode) => node.id);
  for (const siblings of children.values()) siblings.sort(compare);

  const top: GraphArea = { key: TOP_LEVEL_AREA, index: 0, slot: 0, title: null, count: 0 };
  const areas = [top];
  const notes: GraphNote[] = [];
  const byId = new Map<string, GraphNote>();
  const roots = children.get(null) ?? [];
  for (const root of roots) {
    let area = top;
    if (children.has(root.id)) {
      const index = areas.length;
      area = { key: root.id, index, slot: ((index - 1) % 7) + 1, title: root.title, count: 0 };
      areas.push(area);
    }
    // Iterative traversal also handles deeply nested notebooks without stack overflow.
    const stack = [{ node: root, depth: 0 }];
    while (stack.length) {
      const item = stack.pop();
      if (!item) break;
      const { node, depth } = item;
      const note: GraphNote = {
        id: node.id,
        title: node.title,
        parentId: parents.get(node.id) ?? null,
        updatedAt: node.updatedAt,
        area,
        order: notes.length,
        depth,
        out: new Set<string>(),
        in: new Set<string>(),
        neighbours: new Set<string>(),
        deg: 0,
        orphan: true,
      };
      notes.push(note);
      byId.set(note.id, note);
      area.count++;
      for (const child of (children.get(node.id) ?? []).toReversed()) stack.push({ node: child, depth: depth + 1 });
    }
  }
  // Canonical source/target tree order makes edges and Set iteration independent of transport order.
  const outgoing = new Map(notes.map((note) => [note.id, new Set<string>()]));
  const incoming = new Map(notes.map((note) => [note.id, new Set<string>()]));
  const edges: GraphModelEdge[] = [];
  for (const edge of graph.edges) {
    if (edge.source === edge.target || !byId.has(edge.target)) continue;
    outgoing.get(edge.source)?.add(edge.target);
  }
  for (const note of notes) {
    const targets = [...(outgoing.get(note.id) ?? [])].sort((a, b) => (byId.get(a)?.order ?? 0) - (byId.get(b)?.order ?? 0));
    note.out = new Set(targets);
    for (const target of targets) {
      incoming.get(target)?.add(note.id);
      edges.push({ source: note.id, target, sameArea: note.area === byId.get(target)?.area });
    }
  }
  for (const note of notes) {
    note.in = incoming.get(note.id) ?? new Set<string>();
    note.neighbours = new Set([...note.out, ...note.in]);
    note.deg = note.out.size + note.in.size;
    note.orphan = note.deg === 0;
  }
  return { notes, byId, edges, areas };
}

export type GraphLinksFilter = "all" | "linked" | "unlinked";
export type GraphFilter = { links: GraphLinksFilter; hide: readonly string[] };

export function visibleNotes(model: GraphModel, filter: GraphFilter): GraphNote[] {
  const hidden = new Set(filter.hide);
  return model.notes.filter(
    (note) => !hidden.has(note.area.key) && (filter.links === "all" || note.orphan === (filter.links === "unlinked")),
  );
}
export function visibleEdges(model: GraphModel, visibleIds: ReadonlySet<string>): GraphModelEdge[] {
  return model.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
}
export function matchesQuery(note: GraphNote, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  return q.length > 0 && note.title.toLocaleLowerCase().includes(q);
}
