import type { GroupRelations } from "@k2b/cloud/contracts";

/** What the relations page shows; every part lives in the URL, so a reload shows the same picture. */
export type RelationsUrlState = {
  focus?: string;
  sel?: string;
  depth: number;
  view: "graph" | "list";
  managers: boolean;
  expand: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMN = /^[ud][1-4]$/;

export const RELATIONS_PATH = "/app/accounts/groups/relations";

export const parseRelationsUrl = (query: (name: string) => string | undefined): RelationsUrlState => {
  const id = (value: string | undefined) => (value && UUID.test(value) ? value.toLowerCase() : undefined);
  const depth = Number(query("depth"));
  return {
    focus: id(query("focus")),
    sel: id(query("sel")),
    depth: Number.isInteger(depth) && depth >= 1 && depth <= 4 ? depth : 2,
    view: query("view") === "list" ? "list" : "graph",
    managers: query("managers") === "1",
    expand: [...new Set((query("expand") ?? "").split(",").filter((key) => COLUMN.test(key)))],
  };
};

/** The page URL for a state; defaults stay out of the URL. */
export const relationsHref = (state: RelationsUrlState, change: Partial<RelationsUrlState> = {}): string => {
  const next = { ...state, ...change };
  const params = new URLSearchParams();
  if (next.focus) params.set("focus", next.focus);
  if (next.sel && next.sel !== next.focus) params.set("sel", next.sel);
  if (next.depth !== 2) params.set("depth", String(next.depth));
  if (next.view === "list") params.set("view", "list");
  if (next.managers) params.set("managers", "1");
  if (next.expand.length > 0 && next.view === "graph") params.set("expand", next.expand.join(","));
  const search = params.toString();
  return search ? `${RELATIONS_PATH}?${search}` : RELATIONS_PATH;
};

/** Fixed sizes in CSS pixels. Server and browser place every card from them, so the edges need no measuring. */
export const LEVELS = {
  padX: 16,
  padTop: 28,
  lane: 12,
  head: 24,
  column: 172,
  columnGap: 40,
  gap: 4,
  card: 48,
  cycleCard: 64,
  more: 32,
} as const;

export type LevelEntry =
  | { kind: "group"; id: string; y: number; height: number; focus: boolean }
  | { kind: "back"; from: string; to: string; closesCycle: boolean; y: number; height: number }
  | { kind: "more"; key: string; count: number; y: number; height: number };

/** An entry before its column gives it a place. */
type Unplace<Entry> = Entry extends unknown ? Omit<Entry, "y"> : never;
type Unplaced = Unplace<LevelEntry>;

export type LevelColumn = { key: string; direction: "up" | "focus" | "down"; level: number; x: number; entries: LevelEntry[] };

export type LevelPath = { d: string; cycle: boolean; arrow: boolean };

/** Columns from the outermost containing level to the deepest contained level, with every card's place and each edge. */
export const layoutLevels = (relations: GroupRelations) => {
  const inCycle = new Set(relations.nodes.filter((node) => node.inCycle).map((node) => node.id));
  const up = relations.columns.filter((column) => column.key.startsWith("u")).reverse();
  const down = relations.columns.filter((column) => column.key.startsWith("d"));
  const columns: LevelColumn[] = [];
  const place = (key: string, direction: LevelColumn["direction"], level: number, entries: Unplaced[]) => {
    let y = LEVELS.padTop + LEVELS.head;
    const placed = entries.map((entry): LevelEntry => {
      const at = { ...entry, y };
      y += entry.height + LEVELS.gap;
      return at;
    });
    columns.push({ key, direction, level, x: LEVELS.padX + columns.length * (LEVELS.column + LEVELS.columnGap), entries: placed });
    return y;
  };
  const groupHeight = (id: string) => (inCycle.has(id) ? LEVELS.cycleCard : LEVELS.card);
  const fill = (column: GroupRelations["columns"][number]): Unplaced[] => [
    ...column.items.map((item) => ({ kind: "group" as const, id: item.id, height: groupHeight(item.id), focus: false })),
    ...column.backs.map((back) => ({ kind: "back" as const, ...back, height: LEVELS.card })),
    ...(column.hidden > 0 ? [{ kind: "more" as const, key: column.key, count: column.hidden, height: LEVELS.more }] : []),
  ];
  let bottom = 0;
  for (const column of up) bottom = Math.max(bottom, place(column.key, "up", Number(column.key.slice(1)), fill(column)));
  if (relations.focus)
    bottom = Math.max(
      bottom,
      place("f", "focus", 0, [{ kind: "group", id: relations.focus, height: groupHeight(relations.focus), focus: true }]),
    );
  for (const column of down) bottom = Math.max(bottom, place(column.key, "down", Number(column.key.slice(1)), fill(column)));

  // Each group is placed once; a back card is found by its edge.
  const cards = new Map<string, { x: number; y: number; height: number }>();
  for (const column of columns)
    for (const entry of column.entries) {
      const box = { x: column.x, y: entry.y, height: entry.height };
      if (entry.kind === "group") cards.set(entry.id, box);
      if (entry.kind === "back") cards.set(`${entry.from}>${entry.to}`, box);
    }
  const paths: LevelPath[] = [];
  const curve = (from: string, to: string, cycle: boolean) => {
    const a = cards.get(from);
    const b = cards.get(to);
    if (!a || !b) return;
    const ax = a.x + LEVELS.column;
    const ay = a.y + a.height / 2;
    const by = b.y + b.height / 2;
    const dx = Math.max(16, (b.x - ax) / 2);
    paths.push({ d: `M${ax} ${ay}C${ax + dx} ${ay} ${b.x - dx} ${by} ${b.x} ${by}`, cycle, arrow: false });
  };
  for (const column of relations.columns) {
    const isDown = column.key.startsWith("d");
    for (const item of column.items) isDown ? curve(item.via, item.id, false) : curve(item.id, item.via, false);
    for (const back of column.backs) {
      const card = `${back.from}>${back.to}`;
      if (isDown) curve(back.from, card, back.closesCycle);
      else curve(card, back.from, back.closesCycle);
      // A back edge below that closes a cycle also arcs over the columns to the group it leads to.
      const target = cards.get(back.to);
      const start = cards.get(card);
      if (!isDown || !back.closesCycle || !target || !start) continue;
      const sx = start.x + LEVELS.column / 2;
      const tx = target.x + LEVELS.column / 2;
      const lane = LEVELS.lane;
      if (tx >= sx) continue;
      paths.push({
        d: `M${sx} ${start.y}V${lane + 6}Q${sx} ${lane} ${sx - 6} ${lane}H${tx + 6}Q${tx} ${lane} ${tx} ${lane + 6}V${target.y}`,
        cycle: true,
        arrow: true,
      });
    }
  }
  return {
    columns,
    paths,
    width: LEVELS.padX * 2 + columns.length * LEVELS.column + Math.max(0, columns.length - 1) * LEVELS.columnGap,
    height: bottom + LEVELS.padX,
  };
};
