/**
 * Note paths.
 *
 * An address path (`<notebook>:<segment>/<segment>`) names notes by the slugs
 * of their titles. Titles are not unique, so an address segment that matches
 * several siblings is ambiguous and fails; note IDs always work.
 *
 * Mirror paths are the file and folder names of a pulled notebook. They use
 * the same slugs, but a slug that several siblings share carries the note's
 * short ID (`backup--Ab12Cd`), and so does the reserved slug `index`, because
 * a mirror folder stores its own note content in `index.md`. The suffix exists
 * only in mirror names; address paths never parse it.
 */

export const NOTE_PATH_MAX_LENGTH = 2_000;
export const NOTE_PATH_MAX_SEGMENTS = 64;

const SLUG_MAX_LENGTH = 80;
const RESERVED_SLUG = "index";

/**
 * Lowercase ASCII slug: German umlauts and ß are transliterated, other
 * accents are dropped, and every other run of characters becomes one `-`.
 */
export const noteSlug = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, "");
  return slug || "untitled";
};

export type NotePathNode = {
  /** Internal key used for parent references. */
  id: string;
  /** Public short ID used in disambiguated segments. */
  shortId: string;
  parentId: string | null;
  title: string;
};

export type ParsedNotePath = { ok: true; segments: string[] } | { ok: false; error: "too-long" | "too-many-segments" };

/** Split a notebook-relative path; empty segments and surrounding slashes are ignored. */
export const parseNotePath = (path: string): ParsedNotePath => {
  if (path.length > NOTE_PATH_MAX_LENGTH) return { ok: false, error: "too-long" };
  const segments = path
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length > NOTE_PATH_MAX_SEGMENTS) return { ok: false, error: "too-many-segments" };
  return { ok: true, segments };
};

const childrenByParent = <T extends NotePathNode>(nodes: readonly T[]): Map<string | null, T[]> => {
  const ids = new Set(nodes.map((node) => node.id));
  const children = new Map<string | null, T[]>();
  for (const node of nodes) {
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null;
    const list = children.get(parent);
    if (list) list.push(node);
    else children.set(parent, [node]);
  }
  return children;
};

/** Segment of each node among its siblings; mirror segments disambiguate shared slugs. */
const siblingSegments = <T extends NotePathNode>(siblings: readonly T[], mirror: boolean): Map<string, string> => {
  const counts = new Map<string, number>();
  const slugs = siblings.map((node) => noteSlug(node.title));
  for (const slug of slugs) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  return new Map(
    siblings.map((node, index) => {
      const slug = slugs[index]!;
      const unique = !mirror || (counts.get(slug) === 1 && slug !== RESERVED_SLUG);
      return [node.id, unique ? slug : `${slug}--${node.shortId}`];
    }),
  );
};

/**
 * Path of every node, keyed by node ID. Address paths may repeat for sibling
 * notes with the same slug; mirror paths are always unique.
 */
export const buildNotePaths = <T extends NotePathNode>(nodes: readonly T[], options: { mirror: boolean }): Map<string, string> => {
  const children = childrenByParent(nodes);
  const paths = new Map<string, string>();
  const pending: Array<{ parentId: string | null; prefix: string }> = [{ parentId: null, prefix: "" }];
  while (pending.length > 0) {
    const { parentId, prefix } = pending.pop()!;
    const siblings = children.get(parentId) ?? [];
    const segments = siblingSegments(siblings, options.mirror);
    for (const node of siblings) {
      if (paths.has(node.id)) continue;
      const path = `${prefix}${segments.get(node.id)}`;
      paths.set(node.id, path);
      pending.push({ parentId: node.id, prefix: `${path}/` });
    }
  }
  return paths;
};

export type NotePathResolution<T extends NotePathNode> =
  | { kind: "found"; node: T | null }
  | { kind: "missing"; parent: T | null; index: number }
  | { kind: "ambiguous"; index: number; candidates: T[] };

const matchSegment = <T extends NotePathNode>(segment: string, siblings: readonly T[]): T[] => {
  const slug = noteSlug(segment);
  return siblings.filter((node) => noteSlug(node.title) === slug);
};

/**
 * Walk address segments from `startParentId` (the notebook root when null).
 * A segment matches the siblings whose title has the same slug. An empty
 * segment list resolves to the start node.
 */
export const resolveNotePath = <T extends NotePathNode>(
  nodes: readonly T[],
  segments: readonly string[],
  startParentId: string | null = null,
): NotePathResolution<T> => {
  const children = childrenByParent(nodes);
  let current: T | null = startParentId ? (nodes.find((node) => node.id === startParentId) ?? null) : null;
  for (const [index, segment] of segments.entries()) {
    const matches = matchSegment(segment, children.get(current?.id ?? null) ?? []);
    if (matches.length === 0) return { kind: "missing", parent: current, index };
    if (matches.length > 1) return { kind: "ambiguous", index, candidates: matches };
    current = matches[0]!;
  }
  return { kind: "found", node: current };
};

/** Siblings below `parentId` whose title has the same slug as `title`. */
export const siblingsWithTitle = <T extends NotePathNode>(nodes: readonly T[], parentId: string | null, title: string): T[] => {
  const slug = noteSlug(title);
  return (childrenByParent(nodes).get(parentId) ?? []).filter((node) => noteSlug(node.title) === slug);
};
