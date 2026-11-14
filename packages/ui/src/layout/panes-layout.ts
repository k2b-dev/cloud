import { assertUniqueStableUiIds, isStableUiId } from "./stable-id";

export const PANES_LAYOUT_VERSION = 2 as const;
export const PANES_MIN_RATIO = 0.08;
export const PANES_MAX_ID_LENGTH = 160;

export type PanesDirection = "horizontal" | "vertical";
export type PanesSide = "left" | "right" | "top" | "bottom";
export type PanesPathSegment = "first" | "second";
export type PanesPath = readonly PanesPathSegment[];

export type PanesGroup = {
  type: "group";
  items: string[];
  active: string;
};

export type PanesSplit = {
  type: "split";
  direction: PanesDirection;
  ratio: number;
  first: PanesNode;
  second: PanesNode;
};

export type PanesNode = PanesGroup | PanesSplit;

export type PanesLayout = {
  version: typeof PANES_LAYOUT_VERSION;
  root: PanesNode | null;
};

export type PanesIntent =
  | {
      type: "tab";
      itemId: string;
      targetItemId: string;
      beforeItemId: string | null;
    }
  | {
      type: "split";
      itemId: string;
      targetItemId: string;
      side: PanesSide;
    };

export type PanesDropTarget = {
  id: string;
  kind: "tab" | "group" | "split";
  targetItemId: string;
  beforeItemId?: string | null;
  side?: PanesSide;
  intent: PanesIntent;
};

export type PanesDropTargetOptions = {
  movable: boolean;
  split: false | PanesDirection | "both";
};

const MAX_DEPTH = 12;
const MAX_NODES = 64;

type LocatedGroup = {
  group: PanesGroup;
  path: PanesPathSegment[];
  index: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

const isItemId = (value: unknown): value is string => isStableUiId(value, PANES_MAX_ID_LENGTH);

const parseNode = (value: unknown, usedItems: Set<string>, budget: { nodes: number }, depth = 0): PanesNode | null => {
  if (!isRecord(value) || depth > MAX_DEPTH || budget.nodes >= MAX_NODES) return null;
  budget.nodes += 1;

  if (value.type === "group") {
    if (!Array.isArray(value.items) || value.items.length === 0 || !isItemId(value.active)) return null;
    const items: string[] = [];
    for (const item of value.items) {
      if (!isItemId(item) || usedItems.has(item)) return null;
      usedItems.add(item);
      items.push(item);
    }
    if (!items.includes(value.active)) return null;
    return { type: "group", items, active: value.active };
  }

  if (
    value.type !== "split" ||
    (value.direction !== "horizontal" && value.direction !== "vertical") ||
    typeof value.ratio !== "number" ||
    !Number.isFinite(value.ratio) ||
    value.ratio < PANES_MIN_RATIO ||
    value.ratio > 1 - PANES_MIN_RATIO
  ) {
    return null;
  }
  const first = parseNode(value.first, usedItems, budget, depth + 1);
  const second = parseNode(value.second, usedItems, budget, depth + 1);
  if (!first || !second) return null;
  return {
    type: "split",
    direction: value.direction,
    ratio: value.ratio,
    first,
    second,
  };
};

export const parsePanesLayout = (value: unknown): PanesLayout | null => {
  if (!isRecord(value) || value.version !== PANES_LAYOUT_VERSION) return null;
  if (value.root === null) return { version: PANES_LAYOUT_VERSION, root: null };
  const root = parseNode(value.root, new Set<string>(), { nodes: 0 });
  return root ? { version: PANES_LAYOUT_VERSION, root } : null;
};

export const createPanesLayout = (itemIds: readonly string[]): PanesLayout => {
  assertUniqueStableUiIds(itemIds, "Panes item id", PANES_MAX_ID_LENGTH);
  return {
    version: PANES_LAYOUT_VERSION,
    root: itemIds.length > 0 ? { type: "group", items: [...itemIds], active: itemIds[0]! } : null,
  };
};

const findItem = (node: PanesNode | null, itemId: string, path: PanesPathSegment[] = []): LocatedGroup | null => {
  if (!node) return null;
  if (node.type === "group") {
    const index = node.items.indexOf(itemId);
    return index >= 0 ? { group: node, path, index } : null;
  }
  return findItem(node.first, itemId, [...path, "first"]) ?? findItem(node.second, itemId, [...path, "second"]);
};

const firstGroup = (node: PanesNode | null): PanesGroup | null => {
  if (!node) return null;
  return node.type === "group" ? node : firstGroup(node.first);
};

const mapAtPath = (node: PanesNode, path: PanesPath, update: (node: PanesNode) => PanesNode): PanesNode => {
  const [segment, ...rest] = path;
  if (!segment) return update(node);
  if (node.type !== "split") return node;
  if (segment === "first") {
    const first = mapAtPath(node.first, rest, update);
    return first === node.first ? node : { ...node, first };
  }
  const second = mapAtPath(node.second, rest, update);
  return second === node.second ? node : { ...node, second };
};

const removeFromNode = (node: PanesNode, itemId: string): PanesNode | null => {
  if (node.type === "group") {
    const index = node.items.indexOf(itemId);
    if (index < 0) return node;
    const items = node.items.filter((id) => id !== itemId);
    if (items.length === 0) return null;
    const active = node.active === itemId ? items[Math.min(index, items.length - 1)]! : node.active;
    return { ...node, items, active };
  }

  const first = removeFromNode(node.first, itemId);
  const second = removeFromNode(node.second, itemId);
  if (!first) return second;
  if (!second) return first;
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
};

const reconcileNode = (node: PanesNode, desiredOpen: ReadonlySet<string>): PanesNode | null => {
  if (node.type === "group") {
    const items = node.items.filter((itemId) => desiredOpen.has(itemId));
    if (items.length === 0) return null;
    if (sameItems(items, node.items)) return node;
    const active = items.includes(node.active) ? node.active : items[Math.min(node.items.indexOf(node.active), items.length - 1)]!;
    return { ...node, items, active };
  }
  const first = reconcileNode(node.first, desiredOpen);
  const second = reconcileNode(node.second, desiredOpen);
  if (!first) return second;
  if (!second) return first;
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
};

const sameItems = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index]);

const sameNode = (left: PanesNode, right: PanesNode): boolean => {
  if (left.type !== right.type) return false;
  if (left.type === "group" && right.type === "group") {
    return left.active === right.active && sameItems(left.items, right.items);
  }
  if (left.type === "split" && right.type === "split") {
    return (
      left.direction === right.direction &&
      left.ratio === right.ratio &&
      sameNode(left.first, right.first) &&
      sameNode(left.second, right.second)
    );
  }
  return false;
};

const isWithinLayoutLimits = (node: PanesNode, budget = { nodes: 0 }, depth = 0): boolean => {
  if (depth > MAX_DEPTH || budget.nodes >= MAX_NODES) return false;
  budget.nodes += 1;
  return (
    node.type === "group" || (isWithinLayoutLimits(node.first, budget, depth + 1) && isWithinLayoutLimits(node.second, budget, depth + 1))
  );
};

const insertIntoGroup = (group: PanesGroup, itemId: string, beforeItemId: string | null): PanesGroup | null => {
  if (beforeItemId !== null && !group.items.includes(beforeItemId)) return null;
  const items = group.items.filter((id) => id !== itemId);
  const index = beforeItemId === null ? items.length : items.indexOf(beforeItemId);
  if (index < 0) return null;
  items.splice(index, 0, itemId);
  if (sameItems(items, group.items)) return group;
  return { ...group, items, active: itemId };
};

export const activatePanesItem = (layout: PanesLayout, itemId: string): PanesLayout => {
  const located = findItem(layout.root, itemId);
  if (!located || located.group.active === itemId || !layout.root) return layout;
  return {
    version: PANES_LAYOUT_VERSION,
    root: mapAtPath(layout.root, located.path, (node) => (node.type === "group" ? { ...node, active: itemId } : node)),
  };
};

export const isPanesItemVisible = (layout: PanesLayout, itemId: string): boolean => findItem(layout.root, itemId)?.group.active === itemId;

export const removePanesItem = (layout: PanesLayout, itemId: string): PanesLayout => {
  if (!layout.root || !findItem(layout.root, itemId)) return layout;
  return { version: PANES_LAYOUT_VERSION, root: removeFromNode(layout.root, itemId) };
};

export type AddPanesItemOptions = {
  itemId: string;
  targetItemId: string | null;
  beforeItemId?: string | null;
};

export const addPanesItem = (layout: PanesLayout, options: AddPanesItemOptions): PanesLayout => {
  if (!isItemId(options.itemId) || findItem(layout.root, options.itemId)) return layout;
  if (!layout.root) {
    return options.targetItemId === null ? createPanesLayout([options.itemId]) : layout;
  }
  if (options.targetItemId === null) return layout;
  const target = findItem(layout.root, options.targetItemId);
  if (!target) return layout;
  const group = insertIntoGroup(target.group, options.itemId, options.beforeItemId ?? null);
  if (!group) return layout;
  return { version: PANES_LAYOUT_VERSION, root: mapAtPath(layout.root, target.path, () => group) };
};

export const applyPanesIntent = (layout: PanesLayout, intent: PanesIntent): PanesLayout => {
  if (!layout.root || intent.itemId === intent.targetItemId) return layout;
  const source = findItem(layout.root, intent.itemId);
  const target = findItem(layout.root, intent.targetItemId);
  if (!source || !target) return layout;

  if (intent.type === "tab" && source.group === target.group) {
    const group = insertIntoGroup(source.group, intent.itemId, intent.beforeItemId);
    if (!group || group === source.group) return layout;
    return { version: PANES_LAYOUT_VERSION, root: mapAtPath(layout.root, source.path, () => group) };
  }

  const rootWithoutSource = removeFromNode(layout.root, intent.itemId);
  if (!rootWithoutSource) return layout;
  const nextTarget = findItem(rootWithoutSource, intent.targetItemId);
  if (!nextTarget) return layout;

  if (intent.type === "tab") {
    const group = insertIntoGroup(nextTarget.group, intent.itemId, intent.beforeItemId);
    if (!group) return layout;
    return { version: PANES_LAYOUT_VERSION, root: mapAtPath(rootWithoutSource, nextTarget.path, () => group) };
  }

  const direction: PanesDirection = intent.side === "left" || intent.side === "right" ? "horizontal" : "vertical";
  const itemGroup: PanesGroup = { type: "group", items: [intent.itemId], active: intent.itemId };
  const itemFirst = intent.side === "left" || intent.side === "top";
  const nextRoot = mapAtPath(rootWithoutSource, nextTarget.path, (node) => ({
    type: "split",
    direction,
    ratio: 0.5,
    first: itemFirst ? itemGroup : node,
    second: itemFirst ? node : itemGroup,
  }));
  if (!isWithinLayoutLimits(nextRoot) || sameNode(nextRoot, layout.root)) return layout;
  return {
    version: PANES_LAYOUT_VERSION,
    root: nextRoot,
  };
};

export const reconcilePanesLayout = (layout: PanesLayout, desiredOpenItemIds: readonly string[]): PanesLayout => {
  assertUniqueStableUiIds(desiredOpenItemIds, "Panes item id", PANES_MAX_ID_LENGTH);
  const desiredOpen = new Set(desiredOpenItemIds);
  const root = layout.root ? reconcileNode(layout.root, desiredOpen) : null;
  const present = new Set<string>();
  collectPresent(root, present);
  const missing = desiredOpenItemIds.filter((itemId) => !present.has(itemId));
  if (missing.length === 0) return root === layout.root ? layout : { version: PANES_LAYOUT_VERSION, root };
  if (!root) return createPanesLayout(missing);
  const target = firstGroup(root);
  if (!target) return createPanesLayout(missing);
  const located = findItem(root, target.active);
  if (!located) return createPanesLayout(missing);
  const group = { ...located.group, items: [...located.group.items, ...missing] };
  return { version: PANES_LAYOUT_VERSION, root: mapAtPath(root, located.path, () => group) };
};

const collectPresent = (node: PanesNode | null, ids: Set<string>): void => {
  if (!node) return;
  if (node.type === "group") {
    node.items.forEach((item) => ids.add(item));
    return;
  }
  collectPresent(node.first, ids);
  collectPresent(node.second, ids);
};

export const resizePanesSplit = (layout: PanesLayout, path: PanesPath, ratio: number): PanesLayout => {
  if (!layout.root || !Number.isFinite(ratio)) return layout;
  let target: PanesNode = layout.root;
  for (const segment of path) {
    if (target.type !== "split") return layout;
    target = target[segment];
  }
  if (target.type !== "split") return layout;
  const nextRatio = Math.min(1 - PANES_MIN_RATIO, Math.max(PANES_MIN_RATIO, ratio));
  if (nextRatio === target.ratio) return layout;
  return {
    version: PANES_LAYOUT_VERSION,
    root: mapAtPath(layout.root, path, (node) => (node.type === "split" ? { ...node, ratio: nextRatio } : node)),
  };
};

const intentKey = (intent: PanesIntent): string =>
  intent.type === "tab"
    ? `tab:${intent.itemId}:${intent.targetItemId}:${intent.beforeItemId === null ? "end:" : `before:${intent.beforeItemId}`}`
    : `split:${intent.itemId}:${intent.targetItemId}:${intent.side}`;

export const samePanesIntent = (left: PanesIntent | null, right: PanesIntent | null): boolean =>
  left === right ||
  (!!left &&
    !!right &&
    left.type === right.type &&
    left.itemId === right.itemId &&
    left.targetItemId === right.targetItemId &&
    (left.type === "tab" && right.type === "tab"
      ? left.beforeItemId === right.beforeItemId
      : left.type === "split" && right.type === "split" && left.side === right.side));

const canSplitSide = (side: PanesSide, split: PanesDropTargetOptions["split"]): boolean => {
  if (split === false) return false;
  const direction = side === "left" || side === "right" ? "horizontal" : "vertical";
  return split === "both" || split === direction;
};

const collectGroups = (node: PanesNode | null, groups: PanesGroup[] = []): PanesGroup[] => {
  if (!node) return groups;
  if (node.type === "group") groups.push(node);
  else {
    collectGroups(node.first, groups);
    collectGroups(node.second, groups);
  }
  return groups;
};

const nodeAtPath = (node: PanesNode, path: PanesPath): PanesNode | null => {
  let current = node;
  for (const segment of path) {
    if (current.type !== "split") return null;
    current = current[segment];
  }
  return current;
};

const isExistingSplitPlacement = (layout: PanesLayout, source: LocatedGroup, targetItemId: string, side: PanesSide): boolean => {
  if (!layout.root || source.group.items.length !== 1 || source.path.length === 0) return false;
  const segment = source.path[source.path.length - 1]!;
  const parent = nodeAtPath(layout.root, source.path.slice(0, -1));
  if (!parent || parent.type !== "split" || parent.ratio !== 0.5) return false;
  const direction: PanesDirection = side === "left" || side === "right" ? "horizontal" : "vertical";
  const sourceFirst = side === "left" || side === "top";
  if (parent.direction !== direction || (segment === "first") !== sourceFirst) return false;
  const sibling = parent[segment === "first" ? "second" : "first"];
  return sibling.type === "group" && sibling.items.includes(targetItemId);
};

const collectTreeStats = (
  node: PanesNode,
  depth = 0,
  stats: { nodes: number; maxDepth: number; itemDepth: Map<string, number> } = {
    nodes: 0,
    maxDepth: 0,
    itemDepth: new Map(),
  },
) => {
  stats.nodes += 1;
  stats.maxDepth = Math.max(stats.maxDepth, depth);
  if (node.type === "group") node.items.forEach((itemId) => stats.itemDepth.set(itemId, depth));
  else {
    collectTreeStats(node.first, depth + 1, stats);
    collectTreeStats(node.second, depth + 1, stats);
  }
  return stats;
};

export const getPanesDropTargets = (layout: PanesLayout, itemId: string, options: PanesDropTargetOptions): PanesDropTarget[] => {
  if (!options.movable || !layout.root) return [];
  const source = findItem(layout.root, itemId);
  if (!source) return [];
  const rootWithoutSource = removeFromNode(layout.root, itemId);
  const splitStats = rootWithoutSource ? collectTreeStats(rootWithoutSource) : null;
  const targets: PanesDropTarget[] = [];
  const seen = new Set<string>();
  const add = (target: Omit<PanesDropTarget, "id">, noop = false) => {
    const id = intentKey(target.intent);
    if (noop || seen.has(id)) return;
    seen.add(id);
    targets.push({ ...target, id });
  };

  for (const group of collectGroups(layout.root)) {
    const sameGroup = group === source.group;
    const remaining = group.items.filter((id) => id !== itemId);
    const targetItemId = sameGroup ? remaining[0] : group.active;
    if (!targetItemId) continue;
    for (const beforeItemId of remaining) {
      const intent: PanesIntent = { type: "tab", itemId, targetItemId, beforeItemId };
      add(
        {
          kind: "tab",
          targetItemId,
          beforeItemId,
          intent,
        },
        sameGroup && group.items[source.index + 1] === beforeItemId,
      );
    }
    if (sameGroup) {
      const intent: PanesIntent = { type: "tab", itemId, targetItemId, beforeItemId: null };
      add(
        {
          kind: "tab",
          targetItemId,
          beforeItemId: null,
          intent,
        },
        source.index === group.items.length - 1,
      );
    } else {
      add({
        kind: "group",
        targetItemId,
        intent: { type: "tab", itemId, targetItemId, beforeItemId: null },
      });
    }

    for (const side of ["top", "right", "bottom", "left"] as const) {
      if (!canSplitSide(side, options.split)) continue;
      const intent: PanesIntent = { type: "split", itemId, targetItemId, side };
      const targetDepth = splitStats?.itemDepth.get(targetItemId);
      const exceedsLimits =
        !splitStats ||
        targetDepth === undefined ||
        splitStats.nodes + 2 > MAX_NODES ||
        Math.max(splitStats.maxDepth, targetDepth + 1) > MAX_DEPTH;
      add(
        {
          kind: "split",
          targetItemId,
          side,
          intent,
        },
        exceedsLimits || isExistingSplitPlacement(layout, source, targetItemId, side),
      );
    }
  }
  return targets;
};

/** The item IDs of a layout in tree order: left before right, top before bottom, tabs in their order. */
export const panesItemOrder = (layout: PanesLayout): string[] => {
  const ids: string[] = [];
  collectGroups(layout.root).forEach((group) => ids.push(...group.items));
  return ids;
};

const sameShape = (left: PanesNode, right: PanesNode): boolean => {
  if (left.type === "group" || right.type === "group") {
    return left.type === "group" && right.type === "group" && sameItems(left.items, right.items);
  }
  return left.direction === right.direction && sameShape(left.first, right.first) && sameShape(left.second, right.second);
};

/** Whether two layouts place the same items the same way, regardless of split ratios and active tabs. */
export const samePanesArrangement = (left: PanesLayout, right: PanesLayout): boolean =>
  left.root === null || right.root === null ? left.root === right.root : sameShape(left.root, right.root);

const sameSizes = (left: PanesNode, right: PanesNode): boolean => {
  if (left.type === "group" || right.type === "group") {
    return left.type === "group" && right.type === "group" && sameItems(left.items, right.items);
  }
  return (
    left.direction === right.direction &&
    left.ratio === right.ratio &&
    sameSizes(left.first, right.first) &&
    sameSizes(left.second, right.second)
  );
};

/** Whether two layouts place the same items the same way with the same split ratios, regardless of active tabs. */
export const samePanesSizes = (left: PanesLayout, right: PanesLayout): boolean =>
  left.root === null || right.root === null ? left.root === right.root : sameSizes(left.root, right.root);

/** The named arrangements offered by the Arrange menu. */
export const PANES_PRESETS = ["two", "three", "stacked", "tabs"] as const;
export type PanesPreset = (typeof PANES_PRESETS)[number];

const presetDirections: Record<PanesPreset, readonly PanesDirection[]> = {
  two: ["horizontal"],
  three: ["horizontal"],
  stacked: ["horizontal", "vertical"],
  tabs: [],
};
const presetMinimum: Record<PanesPreset, number> = { two: 2, three: 3, stacked: 3, tabs: 2 };

const groupOf = (items: readonly string[], active: string | undefined): PanesGroup => ({
  type: "group",
  items: [...items],
  active: active !== undefined && items.includes(active) ? active : items[0]!,
});

const splitOf = (direction: PanesDirection, ratio: number, first: PanesNode, second: PanesNode): PanesSplit => ({
  type: "split",
  direction,
  ratio,
  first,
  second,
});

/** Whether `preset` can arrange `count` items when only the `split` directions are allowed. */
export const canApplyPanesPreset = (preset: PanesPreset, count: number, split: PanesDropTargetOptions["split"]): boolean =>
  count >= presetMinimum[preset] && presetDirections[preset].every((direction) => split === "both" || split === direction);

/**
 * Arranges `itemIds`, in this order, as a named preset: `two` puts the first item beside the rest as tabs, `three`
 * puts the first two items beside the rest, `stacked` puts the first item beside the second above the rest, and
 * `tabs` keeps every item in one group. `active` stays the visible tab of its group. A `fallback` layout with the
 * same arrangement lends its split ratios, so choosing an application's default arrangement restores its sizes.
 * Returns `null` when there are too few items.
 */
export const applyPanesPreset = (
  preset: PanesPreset,
  itemIds: readonly string[],
  options: { active?: string; fallback?: PanesLayout } = {},
): PanesLayout | null => {
  assertUniqueStableUiIds(itemIds, "Panes item id", PANES_MAX_ID_LENGTH);
  if (itemIds.length < presetMinimum[preset]) return null;
  const [first, second, ...rest] = itemIds as [string, string, ...string[]];
  const active = options.active;
  let root: PanesNode;
  if (preset === "tabs") root = groupOf(itemIds, active);
  else if (preset === "two") root = splitOf("horizontal", 0.5, groupOf([first], active), groupOf([second, ...rest], active));
  else if (preset === "three")
    root = splitOf(
      "horizontal",
      0.34,
      groupOf([first], active),
      splitOf("horizontal", 0.5, groupOf([second], active), groupOf(rest, active)),
    );
  else
    root = splitOf("horizontal", 0.5, groupOf([first], active), splitOf("vertical", 0.5, groupOf([second], active), groupOf(rest, active)));
  const layout: PanesLayout = { version: PANES_LAYOUT_VERSION, root };
  const fallback = options.fallback;
  if (!fallback?.root || !samePanesArrangement(layout, fallback)) return layout;
  const withRatios = (node: PanesNode, source: PanesNode): PanesNode =>
    node.type === "split" && source.type === "split"
      ? { ...node, ratio: source.ratio, first: withRatios(node.first, source.first), second: withRatios(node.second, source.second) }
      : node;
  return { version: PANES_LAYOUT_VERSION, root: withRatios(root, fallback.root) };
};

/** The preset whose arrangement `layout` has for `itemIds`, if any. */
export const getPanesPreset = (layout: PanesLayout, itemIds: readonly string[]): PanesPreset | null =>
  PANES_PRESETS.find((preset) => {
    const candidate = applyPanesPreset(preset, itemIds);
    return candidate !== null && samePanesArrangement(candidate, layout);
  }) ?? null;

/** The split ratio at `path` in `layout`, when a split with that direction is there. */
export const getPanesSplitRatio = (layout: PanesLayout | undefined, path: PanesPath, direction: PanesDirection): number | null => {
  if (!layout?.root) return null;
  const node = nodeAtPath(layout.root, path);
  return node?.type === "split" && node.direction === direction ? node.ratio : null;
};

/**
 * One group with every item in tree order, for a container too narrow for side-by-side panes. It is shown, never
 * stored: the stored layout stays as it is and returns once the container is wide enough again.
 */
export const projectPanesLayout = (layout: PanesLayout, active: string | null): PanesLayout => {
  const items = panesItemOrder(layout);
  if (items.length === 0) return layout;
  return { version: PANES_LAYOUT_VERSION, root: groupOf(items, active ?? firstGroup(layout.root)?.active) };
};

export type PanesMove =
  | { kind: "split"; side: PanesSide; targetItemId: string; intent: PanesIntent }
  | { kind: "group"; targetItemId: string; intent: PanesIntent }
  | { kind: "tab"; direction: "previous" | "next"; intent: PanesIntent };

/**
 * Every place `itemId` can move to, as menu entries: each drop target that changes the arrangement, with the tab
 * order inside its own group as one step to either side. Positions inside another group's tab row are reached by
 * joining that group, then stepping.
 */
export const getPanesMoves = (layout: PanesLayout, itemId: string, options: PanesDropTargetOptions): PanesMove[] => {
  const source = findItem(layout.root, itemId);
  if (!source || !options.movable) return [];
  const moves: PanesMove[] = [];
  const changes = (intent: PanesIntent) => {
    const next = applyPanesIntent(layout, intent);
    return next !== layout && !samePanesArrangement(next, layout);
  };
  for (const target of getPanesDropTargets(layout, itemId, options)) {
    if (target.kind === "split" && target.side && changes(target.intent)) {
      moves.push({ kind: "split", side: target.side, targetItemId: target.targetItemId, intent: target.intent });
    }
    if (target.kind === "group" && changes(target.intent))
      moves.push({ kind: "group", targetItemId: target.targetItemId, intent: target.intent });
  }
  const items = source.group.items;
  const groupTarget = items.find((id) => id !== itemId);
  if (groupTarget && source.index > 0) {
    moves.push({
      kind: "tab",
      direction: "previous",
      intent: { type: "tab", itemId, targetItemId: groupTarget, beforeItemId: items[source.index - 1]! },
    });
  }
  if (groupTarget && source.index < items.length - 1) {
    moves.push({
      kind: "tab",
      direction: "next",
      intent: { type: "tab", itemId, targetItemId: groupTarget, beforeItemId: items[source.index + 2] ?? null },
    });
  }
  return moves;
};
