/**
 * Deterministic, fictional notebook shapes for the large-notebook benchmark.
 *
 * `small` is a typical notebook. `medium` has 1,307 pages: 17 top-level pages
 * and folders of 362, 246, 175, 162, 155, 94, 57 and 39 pages, one level deep.
 * `large` has 20,000 pages with several levels, very large folders and links
 * between pages. The same seed always produces the same tree and Markdown,
 * so numbers stay comparable between runs.
 */

export type FixtureShape = "small" | "medium" | "large";

export type FixtureNote = {
  /** Index in creation order; a parent always comes before its children. */
  index: number;
  parent: number | null;
  title: string;
  /** Indexes of earlier notes this note links to with `note://`. */
  links: number[];
  /** A folder holds other pages; folders may list their children with a query block. */
  kind: "folder" | "page";
  sizeClass: "short" | "medium" | "long";
  table: boolean;
  image: boolean;
  query: boolean;
  toc: boolean;
  tags: string[];
};

export const FIXTURE_SHAPES: Record<FixtureShape, { notes: number; description: string }> = {
  small: { notes: 13, description: "13 pages, two levels" },
  medium: { notes: 1307, description: "1,307 pages: 17 top-level pages, folders of 362, 246, 175, 162, 155, 94, 57 and 39 pages" },
  large: { notes: 20_000, description: "20,000 pages: up to five levels, folders of up to 5,000 pages, about 1.5 links per page" },
};

/** Mulberry32: tiny, fast and stable across runtimes. */
export const seededRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const TOPICS = [
  "Harbor",
  "Orchard",
  "Lantern",
  "Meadow",
  "Quarry",
  "Beacon",
  "Willow",
  "Granite",
  "Falcon",
  "Juniper",
  "Copper",
  "Tundra",
  "Saffron",
  "Cobalt",
  "Marble",
  "Pebble",
  "Thistle",
  "Ember",
  "Glacier",
  "Hazel",
];
const NOUNS = [
  "plan",
  "review",
  "notes",
  "checklist",
  "budget",
  "timeline",
  "research",
  "meeting",
  "draft",
  "summary",
  "proposal",
  "handbook",
  "retro",
  "inventory",
  "roadmap",
  "brief",
];
const TAGS = ["handbook", "project", "meeting", "idea", "todo", "archive", "draft", "reference"];
const WORDS =
  "the team agreed to move the pilot to the next quarter while the vendor reviews the open questions about delivery storage and support every week we compare the numbers with the forecast and write down what changed a short summary goes to the steering group".split(
    " ",
  );

const sentence = (random: () => number, words: number): string => {
  const parts: string[] = [];
  for (let i = 0; i < words; i++) parts.push(WORDS[Math.floor(random() * WORDS.length)]!);
  const text = parts.join(" ");
  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
};

const paragraph = (random: () => number): string =>
  Array.from({ length: 2 + Math.floor(random() * 4) }, () => sentence(random, 8 + Math.floor(random() * 10))).join(" ");

/** Folder sizes per level for the 20,000-page notebook; the rest forms a random tree up to five levels deep. */
const LARGE_FOLDERS = [5000, 2000, 1200, 800, 500, 300, 200];

export function buildFixtureTree(shape: FixtureShape, seed = 20261024): FixtureNote[] {
  const random = seededRandom(seed);
  const notes: FixtureNote[] = [];
  const depthOf: number[] = [];
  const titleCounts = new Map<string, number>();
  const add = (parent: number | null, kind: FixtureNote["kind"]): number => {
    const index = notes.length;
    const base = `${TOPICS[Math.floor(random() * TOPICS.length)]} ${NOUNS[Math.floor(random() * NOUNS.length)]}`;
    const seen = (titleCounts.get(base) ?? 0) + 1;
    titleCounts.set(base, seen);
    const sizeRoll = random();
    notes.push({
      index,
      parent,
      title: seen === 1 ? base : `${base} ${seen}`,
      links: [],
      kind,
      sizeClass: sizeRoll < 0.55 ? "short" : sizeRoll < 0.92 ? "medium" : "long",
      table: random() < 0.15,
      image: random() < 0.08,
      query: kind === "folder" && random() < 0.6,
      toc: random() < 0.05,
      tags: TAGS.filter(() => random() < 0.08),
    });
    depthOf.push(parent === null ? 0 : depthOf[parent]! + 1);
    return index;
  };

  if (shape === "small") {
    const roots = [add(null, "folder"), add(null, "folder"), add(null, "page")];
    for (let i = 0; i < 6; i++) add(roots[0]!, "page");
    for (let i = 0; i < 4; i++) add(roots[1]!, "page");
  } else if (shape === "medium") {
    const folderSizes = [362, 246, 175, 162, 155, 94, 57, 39];
    const roots = Array.from({ length: 17 }, (_, index) => add(null, index < folderSizes.length ? "folder" : "page"));
    folderSizes.forEach((size, folder) => {
      for (let i = 0; i < size; i++) add(roots[folder]!, "page");
    });
  } else {
    const roots = Array.from({ length: 40 }, () => add(null, "folder"));
    LARGE_FOLDERS.forEach((size, folder) => {
      const container = add(roots[folder]!, "folder");
      for (let i = 0; i < size; i++) add(container, "page");
    });
    const total = FIXTURE_SHAPES.large.notes;
    const parents = [...roots];
    while (notes.length < total) {
      const parent = parents[Math.floor(random() * parents.length)]!;
      const isFolder = depthOf[parent]! < 4 && random() < 0.12;
      const created = add(parent, isFolder ? "folder" : "page");
      if (isFolder) parents.push(created);
    }
  }

  // Links only point at earlier notes, so one pass in creation order can resolve every target.
  for (const note of notes) {
    if (note.index === 0) continue;
    const count = random() < 0.4 ? 0 : 1 + Math.floor(random() * 3);
    for (let i = 0; i < count; i++) {
      const target = Math.floor(random() * note.index);
      if (!note.links.includes(target)) note.links.push(target);
    }
  }
  return notes;
}

/**
 * The Markdown of one fixture note. `shortIdOf` resolves the public IDs of
 * earlier notes for `note://` links; `imageId` is an `attach://` attachment.
 */
export function renderFixtureMarkdown(note: FixtureNote, options: { shortIdOf: (index: number) => string | undefined; imageId?: string }) {
  const random = seededRandom(note.index * 7919 + 17);
  const sections = note.sizeClass === "short" ? 2 : note.sizeClass === "medium" ? 5 : 16;
  const lines: string[] = [`# ${note.title}`, ""];
  if (note.tags.length > 0) lines.push(note.tags.map((tag) => `#${tag}`).join(" "), "");
  if (note.toc) lines.push(":::toc", "max-depth: 3", ":::", "");
  if (note.query) {
    lines.push(":::query", "source: notes", "scope: children", "sort:", "  field: $title", "  direction: asc", ":::", "");
  }
  for (let section = 0; section < sections; section++) {
    lines.push(`## ${sentence(random, 3).slice(0, -1)}`, "", paragraph(random), "");
    if (section === 0 && note.table) {
      lines.push("| Item | Owner | Status |", "| --- | --- | --- |");
      for (let row = 0; row < 6; row++)
        lines.push(`| ${sentence(random, 2).slice(0, -1)} | Person ${row + 1} | ${row % 2 ? "open" : "done"} |`);
      lines.push("");
    }
    if (section === 0 && note.image && options.imageId) lines.push(`![Diagram](attach://${options.imageId})`, "");
    if (section % 3 === 1) lines.push(`- [ ] ${sentence(random, 5)}`, `- [x] ${sentence(random, 4)}`, "");
  }
  const links = note.links.map((target) => options.shortIdOf(target)).filter((id): id is string => !!id);
  if (links.length > 0) lines.push("## Related", "", ...links.map((id, i) => `- [Related page ${i + 1}](note://${id})`), "");
  return lines.join("\n");
}
