import { withoutFencedCode } from "./markdown";

const requiredMeta = ["title", "navTitle", "section", "order", "description", "tags", "updated"] as const;

export const metadataErrors = (meta: Record<string, string>): string[] => {
  const errors: string[] = [];

  for (const field of requiredMeta) {
    if (!meta[field]?.trim()) {
      errors.push(`missing frontmatter field '${field}'`);
    }
  }

  if (meta.order && !/^[1-9]\d*$/.test(meta.order)) {
    errors.push("order must be a positive integer");
  }

  if (meta.tags) {
    const match = meta.tags.match(/^\[(.*)\]$/);
    const tags = match?.[1]
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (!tags?.length) {
      errors.push("tags must be a non-empty inline list");
    }
  }

  if (meta.updated) {
    const match = meta.updated.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const parsed = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
    if (!match || !parsed || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== meta.updated) {
      errors.push("updated must be a valid YYYY-MM-DD date");
    }
  }

  return errors;
};

export const headingContractErrors = (prose: string, title: string | undefined): string[] => {
  const headings = [...prose.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)].map((match) => ({
    level: match[1].length,
    text: match[2].trim(),
  }));
  const h1s = headings.filter((heading) => heading.level === 1);
  const errors: string[] = [];

  if (h1s.length === 0) {
    errors.push("missing H1");
    return errors;
  }
  if (h1s.length > 1) {
    errors.push("must contain exactly one H1");
  }
  if (headings[0]?.level !== 1) {
    errors.push("H1 must be the first heading");
  }
  if (title && h1s[0].text !== title) {
    errors.push(`H1 '${h1s[0].text}' does not match title '${title}'`);
  }

  return errors;
};

export const conventionPrefixes = ["CODE", "SRV", "ACC", "DATA", "UI", "IX", "A11Y", "I18N", "DOC", "CLI", "TEST", "REL"] as const;

const conventionId = new RegExp(`^(${conventionPrefixes.join("|")})-\\d{2}$`);
const conventionColumns = ["ID", "Rule", "Why", "How to check", "Canonical"];

export const fibelSlug = (text: string): string =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const uiHeadingIds = (markdown: string): Set<string> => {
  const ids = new Set<string>();
  let skippedTitle = false;
  for (const match of withoutFencedCode(markdown).matchAll(/^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/gm)) {
    if (match[1] === "#" && !skippedTitle) {
      skippedTitle = true;
      continue;
    }
    ids.add(fibelSlug(match[2]));
  }
  return ids;
};

const tableCells = (line: string): string[] => {
  const cells: string[] = [];
  let cell = "";
  const row = line.trim();
  for (let index = 0; index < row.length; index++) {
    const char = row[index];
    if (char === "\\") {
      cell += char + (row[++index] ?? "");
    } else if (char === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  if (row.startsWith("|")) cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells;
};

/** Tables whose first header cell matches, including headers for column validation. */
function* conventionTableRows(prose: string, firstColumn: string) {
  let inTable = false;
  const lines = prose.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.includes("|")) {
      inTable = false;
      continue;
    }
    const cells = tableCells(line);
    const header =
      cells[0] === firstColumn &&
      lines[index + 1]?.includes("|") &&
      tableCells(lines[index + 1] ?? "").every((cell) => /^:?-+:?$/.test(cell));
    if (header) inTable = true;
    if (!inTable || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    yield { cells, line: index + 1, header: Boolean(header) };
  }
}

/** Validate catalog rows and consecutive IDs across the selected pages. */
export const conventionCatalogErrors = (pages: readonly { file: string; prose: string }[]): string[] => {
  const errors: string[] = [];
  const owners = new Map<string, string>();
  const ids = new Map<string, Set<number>>();

  for (const page of pages) {
    for (const { cells, line, header } of conventionTableRows(page.prose, "ID")) {
      const location = `${page.file}:${line}`;
      if (header) {
        if (cells.length !== conventionColumns.length || cells.some((cell, index) => cell !== conventionColumns[index])) {
          errors.push(`${location}: convention table must use the columns ID | Rule | Why | How to check | Canonical`);
        }
        continue;
      }

      const id = cells[0] ?? "";
      if (cells.length !== conventionColumns.length) {
        errors.push(`${location}: convention ${id} has ${cells.length} cells instead of 5; escape '|' as \\|`);
      }
      if (!conventionId.test(id)) {
        errors.push(`${location}: invalid convention ID '${id}'`);
      } else {
        const [prefix, number] = id.split("-");
        const numbers = ids.get(prefix) ?? new Set<number>();
        numbers.add(Number(number));
        ids.set(prefix, numbers);
      }
      const owner = owners.get(id);
      if (owner) errors.push(`${location}: duplicate convention ID '${id}' (first in ${owner})`);
      else owners.set(id, location);

      const links = [...(cells[4] ?? "").matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)];
      const target = links[0]?.[1] ?? "";
      if (
        links.length !== 1 ||
        !(target.startsWith("/en/docs/") || target.startsWith("/en/ui")) ||
        target.startsWith("/en/docs/conventions")
      ) {
        errors.push(`${location}: convention ${id} needs exactly one canonical /en/docs or /en/ui link`);
      }
      for (const index of [1, 2, 3]) {
        if (!cells[index]) errors.push(`${location}: convention ${id} has an empty '${conventionColumns[index]}' cell`);
      }
    }
  }

  for (const prefix of conventionPrefixes) {
    const numbers = ids.get(prefix);
    if (!numbers) continue;
    for (let number = 1; number <= Math.max(numbers.size, ...numbers); number++) {
      if (!numbers.has(number)) {
        errors.push(
          `convention IDs for ${prefix} skip ${prefix}-${String(number).padStart(2, "0")}; retire a rule instead of deleting its row`,
        );
      }
    }
  }
  return errors;
};

/** Require every convention prefix and a matching index link, even during partial checks. */
export const conventionCoverageErrors = (pages: readonly { file: string; route: string; prose: string }[]): string[] => {
  const errors: string[] = [];
  const prefixesByRoute = new Map<string, Set<string>>();
  for (const page of pages) {
    const prefixes = new Set<string>();
    for (const { cells, header } of conventionTableRows(page.prose, "ID")) {
      if (!header && conventionId.test(cells[0] ?? "")) prefixes.add(cells[0].split("-")[0]);
    }
    prefixesByRoute.set(page.route, prefixes);
  }
  for (const prefix of conventionPrefixes) {
    if (![...prefixesByRoute.values()].some((prefixes) => prefixes.has(prefix))) {
      errors.push(`convention prefix ${prefix} has no row on any conventions page`);
    }
  }

  const index = pages.find((page) => page.route === "/en/docs/conventions");
  if (!index) {
    errors.push("convention index page /en/docs/conventions is missing");
    return errors;
  }
  const rows = [...conventionTableRows(index.prose, "Prefix")];
  if (rows.length === 0) errors.push(`${index.file}: convention index prefix table is missing`);
  const indexed = new Set<string>();
  for (const { cells, line, header } of rows) {
    if (header) continue;
    const prefix = cells[0] ?? "";
    const location = `${index.file}:${line}`;
    if (!conventionPrefixes.some((known) => known === prefix)) {
      errors.push(`${location}: convention index has unknown prefix '${prefix}'`);
    }
    indexed.add(prefix);
    const links = [...(cells[2] ?? "").matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)];
    const route = (links[0]?.[1] ?? "").split("#", 1)[0];
    if (links.length !== 1 || !/^\/en\/docs\/conventions\/[^/#]+$/.test(route)) {
      errors.push(`${location}: convention index prefix ${prefix} needs exactly one conventions page link`);
    } else if (!prefixesByRoute.get(route)?.has(prefix)) {
      errors.push(`${location}: convention index prefix ${prefix} links to ${route}, which has no ${prefix} rows`);
    }
  }
  for (const prefix of conventionPrefixes) {
    if (!indexed.has(prefix)) errors.push(`${index.file}: convention index has no prefix row for ${prefix}`);
  }
  return errors;
};

/** Resolve a UI route and its optional heading anchor against the catalog. */
export const uiLinkError = (href: string, uiPages: ReadonlyMap<string, ReadonlySet<string>>): string | null => {
  if (!href.startsWith("/en/ui")) return null;
  const [rawRoute, rawFragment] = href.split("#", 2);
  const route = rawRoute.split("?", 1)[0].replace(/\/+$/, "");
  const headings = uiPages.get(route);
  if (!headings) return `broken UI link '${href}'`;
  if (rawFragment !== undefined) {
    const fragment = decodeURIComponent(rawFragment);
    if (!headings.has(fragment)) return `missing anchor '#${fragment}' in UI page ${route}`;
  }
  return null;
};
