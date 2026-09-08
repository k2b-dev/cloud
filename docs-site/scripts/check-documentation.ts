import { readdir } from "node:fs/promises";
import path from "node:path";
import { headingContractErrors, metadataErrors } from "./documentation-rules";
import { withoutFencedCode } from "./markdown";

type Page = {
  absolutePath: string;
  relativePath: string;
  route: string;
  body: string;
  prose: string;
  headings: Map<string, number>;
  meta: Record<string, string>;
};

const siteRoot = path.resolve(import.meta.dir, "..");
const docsRoot = path.join(siteRoot, "docs", "en");
const requestedPaths = Bun.argv.slice(2).map((value) => path.resolve(siteRoot, value));

const allowedSections = new Set([
  "Start",
  "Build an app",
  "Server",
  "Identity and access",
  "Data",
  "Platform services",
  "Automation",
  "Frontend",
  "AI",
  "Operations",
  "Accounts & sign-in",
  "Reference",
  "Contributing",
]);

const errors: string[] = [];

const collectMarkdown = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectMarkdown(entryPath);
      return entry.isFile() && entry.name.endsWith(".md") ? [entryPath] : [];
    }),
  );
  return files.flat().sort();
};

const stripQuotes = (value: string): string => {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseDocument = (absolutePath: string, source: string): { meta: Record<string, string>; body: string } => {
  const relativePath = path.relative(siteRoot, absolutePath);
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    errors.push(`${relativePath}: missing or malformed frontmatter`);
    return { meta: {}, body: source };
  }

  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (field) meta[field[1]] = stripQuotes(field[2]);
  }

  return { meta, body: match[2] };
};

const slugify = (heading: string): string =>
  heading
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

const routeFor = (absolutePath: string): string => {
  const relative = path.relative(docsRoot, absolutePath).replaceAll(path.sep, "/").replace(/\.md$/, "");
  if (relative === "index") return "/en/docs";
  if (relative.endsWith("/index")) {
    return `/en/docs/${relative.slice(0, -"/index".length)}`;
  }
  return `/en/docs/${relative}`;
};

const allFiles = await collectMarkdown(docsRoot);
const pages = new Map<string, Page>();

for (const absolutePath of allFiles) {
  const source = await Bun.file(absolutePath).text();
  const { meta, body } = parseDocument(absolutePath, source);
  const prose = withoutFencedCode(body);
  const headings = new Map<string, number>();

  for (const match of prose.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)) {
    const slug = slugify(match[2]);
    headings.set(slug, (headings.get(slug) ?? 0) + 1);
  }

  const page: Page = {
    absolutePath,
    relativePath: path.relative(siteRoot, absolutePath),
    route: routeFor(absolutePath),
    body,
    prose,
    headings,
    meta,
  };
  pages.set(page.route, page);
}

const selectedPages = [...pages.values()].filter((page) => {
  if (requestedPaths.length === 0) return true;
  return requestedPaths.some(
    (requestedPath) => page.absolutePath === requestedPath || page.absolutePath.startsWith(`${requestedPath}${path.sep}`),
  );
});

if (selectedPages.length === 0) {
  errors.push("No documentation pages matched the requested paths.");
}

const orderOwners = new Map<string, string>();

for (const page of selectedPages) {
  const proseWithoutInlineCode = page.prose.replace(/`[^`\n]+`/g, "");

  for (const error of metadataErrors(page.meta)) {
    errors.push(`${page.relativePath}: ${error}`);
  }

  if (page.meta.section && !allowedSections.has(page.meta.section)) {
    errors.push(`${page.relativePath}: unknown section '${page.meta.section}'`);
  }

  if (page.meta.section && page.meta.order) {
    const key = `${page.meta.section}:${page.meta.order}`;
    const owner = orderOwners.get(key);
    if (owner) {
      errors.push(`${page.relativePath}: duplicates section order ${key} from ${owner}`);
    } else {
      orderOwners.set(key, page.relativePath);
    }
  }

  for (const error of headingContractErrors(page.prose, page.meta.title)) {
    errors.push(`${page.relativePath}: ${error}`);
  }

  for (const [slug, count] of page.headings) {
    if (count > 1) {
      errors.push(`${page.relativePath}: duplicate heading anchor '#${slug}'`);
    }
  }

  for (const match of page.prose.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    if (match[1].includes("`")) {
      errors.push(`${page.relativePath}: code is not allowed in headings`);
    }
  }

  if (/\b(?:TODO|TBD|placeholder|coming soon|to be documented)\b/i.test(proseWithoutInlineCode)) {
    errors.push(`${page.relativePath}: contains placeholder wording`);
  }

  if (/\b(?:simply|seamless|powerful|super easy|in order to)\b/i.test(proseWithoutInlineCode)) {
    errors.push(`${page.relativePath}: contains blocked filler wording`);
  }

  for (const link of page.prose.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    const label = link[1].trim().toLowerCase();
    const href = link[2];

    if (["here", "this page", "read more", "learn more"].includes(label)) {
      errors.push(`${page.relativePath}: link text '${link[1]}' is not meaningful`);
    }

    if (!href.startsWith("/en/docs")) continue;

    const [rawTarget, rawFragment] = href.split("#", 2);
    let targetRoute = rawTarget.replace(/\/+$/, "") || "/en/docs";
    if (targetRoute.endsWith(".markdown")) {
      targetRoute = targetRoute.slice(0, -".markdown".length);
    } else if (targetRoute.endsWith(".md")) {
      targetRoute = targetRoute.slice(0, -".md".length);
    }

    const target = pages.get(targetRoute);
    if (!target) {
      errors.push(`${page.relativePath}: broken documentation link '${href}'`);
      continue;
    }

    if (rawFragment) {
      const fragment = decodeURIComponent(rawFragment);
      if (!target.headings.has(fragment)) {
        errors.push(`${page.relativePath}: missing anchor '#${fragment}' in ${target.relativePath}`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`Documentation check failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Documentation check passed for ${selectedPages.length} page(s); ` + `${pages.size} page(s) indexed for links.`);
