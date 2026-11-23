import type { GroupRelations, UserProvider } from "../../contracts/shared";
import { sql } from "../../runtime/clients";
import { toPgUuidArray } from "../postgres";
import { adjacency, componentIndex, cycleComponents, cycleWitness, type Next, relationLevels } from "./group-graph";

/**
 * Edges of each kind (membership, management) one relations request reads at most. The budget is a quarter second
 * of server time for the relations in the page's SSR path: walking 20,000 pairs in memory (sorting, cycles, levels)
 * took 0.1 to 0.17 s on a loaded shared development host on 23 Nov 2026, 100,000 pairs took 0.2 to 0.5 s.
 * Above the limit the response says `truncated`, and the view says cycles were checked only in part.
 */
export const GROUP_RELATION_EDGE_LIMIT = 20_000;
/** A column, and the top groups of the list, show 10 groups plus "more", as the relations view was designed. */
export const GROUP_RELATION_COLUMN_BUDGET = 10;
/** The details of the selection list 6 groups per relation plus "and n more". */
export const GROUP_RELATION_DETAIL_BUDGET = 6;

type EdgeRow = { kind: "member" | "manager"; source: string; target: string; source_name: string; target_name: string };
type NodeRow = {
  group_count: number | string;
  id: string | null;
  name: string | null;
  provider: UserProvider | null;
  members: number | string | null;
};

export type GroupRelationsQuery = {
  focus?: string;
  selected?: string;
  depth: number;
  managers: boolean;
  view: "graph" | "list";
  /** Column keys, or `roots`, shown without the budget. */
  expand?: readonly string[];
  /** Overrides `GROUP_RELATION_EDGE_LIMIT`, for tests of a cut read. */
  edgeLimit?: number;
  signal?: AbortSignal;
};

/** Which way a column walks from the focus. */
const columnKey = (direction: "up" | "down", level: number) => `${direction === "up" ? "u" : "d"}${level}`;

const listOf = (ids: readonly string[]) => ({ ids: ids.slice(0, GROUP_RELATION_DETAIL_BUDGET), total: ids.length });

/**
 * The relations around one group, for administrators only (the caller checks). Two statements whatever the depth,
 * nesting, or cycles: every edge as a pair, then the groups the answer names. Levels and cycles are computed
 * here, never with a recursive query. Returns `null` when the requested focus is unknown or a personal group.
 */
export const loadGroupRelations = async (query: GroupRelationsQuery): Promise<GroupRelations | null> => {
  const limit = query.edgeLimit ?? GROUP_RELATION_EDGE_LIMIT;
  // Each kind has its own limit and a stable order by primary key, so a cut read is the same on every reload
  // and management edges never push out membership edges.
  const edgeRows = await sql<EdgeRow[]>`
    (
      SELECT 'member' AS kind, gg.parent_group_id AS source, gg.child_group_id AS target,
        source_group.name AS source_name, target_group.name AS target_name
      FROM auth.group_groups_v2 gg
      JOIN auth.groups source_group ON source_group.id = gg.parent_group_id
      JOIN auth.groups target_group ON target_group.id = gg.child_group_id
      WHERE NOT EXISTS (SELECT 1 FROM auth.personal_groups p WHERE p.group_id IN (gg.parent_group_id, gg.child_group_id))
      ORDER BY gg.parent_group_id, gg.child_group_id
      LIMIT ${limit + 1}
    )
    ${
      query.managers
        ? sql`
    UNION ALL
    (
      SELECT 'manager' AS kind, gmg.manager_group_id AS source, gmg.group_id AS target,
        source_group.name AS source_name, target_group.name AS target_name
      FROM auth.group_manager_groups_v2 gmg
      JOIN auth.groups source_group ON source_group.id = gmg.manager_group_id
      JOIN auth.groups target_group ON target_group.id = gmg.group_id
      WHERE NOT EXISTS (SELECT 1 FROM auth.personal_groups p WHERE p.group_id IN (gmg.manager_group_id, gmg.group_id))
      ORDER BY gmg.group_id, gmg.manager_group_id
      LIMIT ${limit + 1}
    )`
        : sql``
    }
  `;
  query.signal?.throwIfAborted();

  // The one row past the limit of a kind only says that its read was cut.
  const memberRows = edgeRows.filter((row) => row.kind === "member");
  const managerRows = edgeRows.filter((row) => row.kind === "manager");
  const truncated = memberRows.length > limit;
  const managersTruncated = managerRows.length > limit;
  const names = new Map<string, string>();
  const pairsOf = (rows: EdgeRow[]) =>
    rows.slice(0, limit).map((row): [string, string] => {
      names.set(row.source, row.source_name);
      names.set(row.target, row.target_name);
      return [row.source, row.target];
    });
  const memberPairs = pairsOf(memberRows);
  const managerPairs = pairsOf(managerRows);

  const byName = (left: string, right: string) => names.get(left)!.localeCompare(names.get(right)!) || left.localeCompare(right);
  const members = adjacency(memberPairs, byName);
  const managers = adjacency(managerPairs, byName);
  const cycles = cycleComponents([...members.nodes].sort(byName), members.down);
  const cycleOf = componentIndex(cycles);
  const managerCycles = query.managers ? cycleComponents([...managers.nodes].sort(byName), managers.down) : [];
  const managerCycleOf = componentIndex(managerCycles);

  // Without a requested focus, start at the group with the most direct membership edges.
  const focus =
    query.focus ??
    [...members.nodes].reduce<string | null>((best, id) => {
      if (!best) return id;
      const weight = (group: string) => members.down(group).length + members.up(group).length;
      return weight(id) > weight(best) || (weight(id) === weight(best) && byName(id, best) < 0) ? id : best;
    }, null);

  const expanded = new Set(query.expand ?? []);
  const budgetOf = (key: string) => (expanded.has(key) ? Number.POSITIVE_INFINITY : GROUP_RELATION_COLUMN_BUDGET);
  const columns: GroupRelations["columns"] = [];
  const named = new Set<string>();
  if (focus && query.view === "graph") {
    const seen = new Set([focus]);
    const down = relationLevels(focus, query.depth, members.down, seen, { budget: (level) => budgetOf(columnKey("down", level)) });
    const shownBacks = new Set(down.flatMap((level) => level.backs.map((back) => `${back.from}>${back.to}`)));
    const up = relationLevels(focus, query.depth, members.up, seen, {
      budget: (level) => budgetOf(columnKey("up", level)),
      // Drawn once: an edge already shown as a back edge below is not repeated above.
      skipBack: (from, to) => shownBacks.has(`${to}>${from}`),
    });
    const column = (direction: "up" | "down", level: (typeof down)[number], position: number) => {
      for (const item of level.items) named.add(item.id).add(item.via);
      for (const back of level.backs) named.add(back.from).add(back.to);
      return {
        key: columnKey(direction, position + 1),
        items: level.items,
        backs: level.backs.map((back) => {
          const component = cycleOf.get(back.from);
          return { ...back, closesCycle: component !== undefined && component === cycleOf.get(back.to) };
        }),
        hidden: level.hidden,
      };
    };
    const shown = (level: (typeof down)[number]) => level.items.length + level.backs.length + level.hidden > 0;
    up.forEach((level, position) => {
      if (shown(level)) columns.push(column("up", level, position));
    });
    down.forEach((level, position) => {
      if (shown(level)) columns.push(column("down", level, position));
    });
  }

  let roots: GroupRelations["roots"] = null;
  if (query.view === "list") {
    // A cycle that no outside group contains has no top; its first group by name stands in for it.
    const closed = (component: string[]) =>
      component.every((id) => members.up(id).every((parent) => cycleOf.get(parent) === cycleOf.get(id)));
    const all = [...members.nodes]
      .filter((id) => members.up(id).length === 0)
      .concat(cycles.filter(closed).map((component) => [...component].sort(byName)[0]!))
      .sort(byName);
    const ids = all.slice(0, budgetOf("roots"));
    roots = { ids, hidden: all.length - ids.length };
    for (const id of ids) named.add(id);
  }

  const selectedId = query.selected ?? focus;
  let selected: GroupRelations["selected"] = null;
  if (selectedId) {
    const witness = (id: string, next: Next, of: Map<string, number>, components: string[][]) => {
      const component = of.get(id);
      return component === undefined ? null : { path: cycleWitness(id, next, of), size: components[component]!.length };
    };
    selected = {
      id: selectedId,
      parents: listOf(members.up(selectedId)),
      children: listOf(members.down(selectedId)),
      manages: query.managers ? listOf(managers.down(selectedId)) : null,
      managedBy: query.managers ? listOf(managers.up(selectedId)) : null,
      cycle: witness(selectedId, members.down, cycleOf, cycles),
      managerCycle: query.managers ? witness(selectedId, managers.down, managerCycleOf, managerCycles) : null,
    };
    named.add(selectedId);
    for (const list of [selected.parents, selected.children, selected.manages, selected.managedBy])
      for (const id of list?.ids ?? []) named.add(id);
    for (const id of [...(selected.cycle?.path ?? []), ...(selected.managerCycle?.path ?? [])]) named.add(id);
  }
  if (focus) named.add(focus);
  if (cycles[0]) named.add(cycles[0][0]!);

  query.signal?.throwIfAborted();
  const nodeRows = await sql<NodeRow[]>`
    WITH total AS (
      SELECT count(*)::int AS group_count
      FROM auth.groups g
      WHERE NOT EXISTS (SELECT 1 FROM auth.personal_groups p WHERE p.group_id = g.id)
    )
    SELECT total.group_count, named.id, named.name, named.provider, named.members
    FROM total
    LEFT JOIN (
      SELECT g.id, g.name, g.provider,
        (SELECT count(*) FROM auth.user_groups_v2 ug WHERE ug.group_id = g.id)
          + (SELECT count(*) FROM auth.service_account_groups sg WHERE sg.group_id = g.id) AS members
      FROM auth.groups g
      WHERE g.id = ANY(${toPgUuidArray([...named])}::uuid[])
        AND NOT EXISTS (SELECT 1 FROM auth.personal_groups p WHERE p.group_id = g.id)
    ) named ON true
    ORDER BY named.name, named.id
  `;
  const nodes = nodeRows.flatMap((row) =>
    row.id && row.name && row.provider
      ? [
          {
            id: row.id,
            name: row.name,
            provider: row.provider,
            members: Number(row.members ?? 0),
            contains: members.down(row.id).length,
            inCycle: cycleOf.has(row.id),
          },
        ]
      : [],
  );
  const known = new Set(nodes.map((node) => node.id));
  if (query.focus && !known.has(query.focus)) return null;
  if (query.selected && !known.has(query.selected)) selected = null;

  return {
    focus: focus && known.has(focus) ? focus : null,
    depth: query.depth,
    managers: query.managers,
    groupCount: Number(nodeRows[0]?.group_count ?? 0),
    nodes,
    columns,
    roots,
    selected,
    cycles: { count: cycles.length, first: cycles[0]?.[0] ?? null },
    truncated,
    cyclesComplete: !truncated,
    managerCyclesComplete: !managersTruncated,
  };
};
