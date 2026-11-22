export interface ReleaseConfig {
  packages: Record<string, { component?: string }>;
}

export interface BumpedComponent {
  path: string;
  component: string;
  version: string;
}

export interface ReleaseData {
  component?: string;
  version?: string;
  notes: string;
}

export function bumpedComponents(config: ReleaseConfig, before: Record<string, string>, after: Record<string, string>): BumpedComponent[] {
  return Object.entries(after).flatMap(([path, version]) => {
    if (Object.hasOwn(before, path) && before[path] === version) return [];
    const component = Object.hasOwn(config.packages, path) ? config.packages[path]?.component : undefined;
    if (!component) throw new Error(`Bumped manifest path ${path} (${version}) has no component in release-please-config.json`);
    return [{ path, component, version }];
  });
}

export function verifyReleaseData(bumped: BumpedComponent[], releaseData: ReleaseData[]): string[] {
  const findings: string[] = [];
  for (const expected of bumped) {
    const parsed = releaseData.find((release) => release.component === expected.component);
    if (!parsed) {
      findings.push(`Missing ${expected.component} ${expected.version}: release-please will not create that release on merge.`);
    } else if (parsed.version !== expected.version) {
      findings.push(
        `${expected.component}: parsed version ${parsed.version ?? "(missing)"} differs from manifest version ${expected.version}.`,
      );
    }
  }
  const summaries = [...bumped, ...releaseData];
  for (const release of releaseData) {
    const seen = new Set<string>();
    for (const other of summaries) {
      if (!other.component || !other.version || other.component === release.component) continue;
      const summary = `${other.component}: ${other.version}`;
      // A component such as cloud must not match the suffix of npm-cloud.
      const escaped = summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!seen.has(summary) && new RegExp(`(?<![\\w-])${escaped}(?![\\w+-])`).test(release.notes)) {
        findings.push(`${release.component ?? "(unnamed release)"} notes contain ${summary}: swallowed section from ${other.component}.`);
        seen.add(summary);
      }
    }
  }
  return findings;
}

function snippets(text: string, skipStructuralTags: boolean): string[] {
  const snippets: string[] = [];
  for (const match of text.matchAll(/<!--|<\/?[a-z]/gi)) {
    if (skipStructuralTags && /^<\/?(?:details|summary)>/.test(text.slice(match.index))) continue;
    snippets.push(
      text
        .slice(Math.max(0, match.index - 15), match.index + match[0].length + 15)
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  return snippets;
}

export function markupSnippets(text: string): string[] {
  return snippets(text, true);
}

/**
 * The body as the squash merge writes it into the commit message on `main` (#1592). Each line
 * longer than 72 columns outside a fenced code block is wrapped greedily at whitespace; the
 * wrapped lines lose their indentation and repeated spaces, and a word longer than 72 columns at
 * the start of a line moves to its own line after an empty one. This reproduces every squash
 * commit on `main` whose pull request body was not edited after the merge (377 of the last 391; the other 14 were edited).
 */
export function squashBody(body: string): string {
  const width = 72;
  let fenced = false;
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        fenced = !fenced;
        return [line];
      }
      if (fenced || line.length <= width) return [line];
      const lines: string[] = [];
      let current: string | undefined;
      for (const word of line.split(/\s+/).filter(Boolean)) {
        if ((current?.length ?? -1) + 1 + word.length > width) {
          lines.push(current ?? "");
          current = word;
        } else current = current === undefined ? word : `${current} ${word}`;
      }
      lines.push(current ?? "");
      return lines;
    })
    .join("\n");
}

/** The squash commit message that lands on `main`, without the trailers GitHub appends. */
export function squashMessage(title: string, number: string, body: string): string {
  const header = `${title} (#${number})`;
  const wrapped = squashBody(body).trimEnd();
  return wrapped ? `${header}\n\n${wrapped}` : header;
}

/** Whether release-please reads a `BEGIN_COMMIT_OVERRIDE` block from this body instead of the commit message. */
export function hasCommitOverride(body: string): boolean {
  return Boolean((body.split("BEGIN_COMMIT_OVERRIDE")[1] ?? "").split("END_COMMIT_OVERRIDE")[0]?.trim());
}

/** One entry that release-please parsed from a commit, as its changelog filter sees it. */
export interface ParsedEntry {
  header: string;
  /** Kept by release-please's `filterCommits` with the default sections, which this repository uses. */
  visible: boolean;
  breaking: boolean;
}

/**
 * Findings for what release-please's `parseConventionalCommits` made of a squash commit: a
 * dropped part, no entry, or, without an override, a missing title entry or an extra entry that
 * reaches the changelog or the version. Extra entries of hidden types, such as a `docs: n/a`
 * line or a wrapped `https: //…` link, change neither and pass.
 */
export function squashCommitFindings(header: string, body: string, entries: ParsedEntry[], messages: string[]): string[] {
  const findings = messages
    .filter((message) => message.startsWith("commit could not be parsed") || message.startsWith("error message:"))
    .map((message) => `release-please drops a part of the squash commit: ${message}`);
  if (hasCommitOverride(body)) {
    if (!entries.length) findings.push("The BEGIN_COMMIT_OVERRIDE block yields no release-please entry.");
    return findings;
  }
  if (!entries.some((entry) => entry.header === header)) {
    const read = entries.length ? entries.map((entry) => JSON.stringify(entry.header)).join(", ") : "no entry";
    findings.push(`release-please does not read the title's entry ${JSON.stringify(header)} from the squash commit; it reads ${read}.`);
  }
  for (const entry of entries) {
    if (entry.header !== header && (entry.visible || entry.breaking)) {
      findings.push(
        `The squash commit yields an extra ${entry.breaking ? "breaking" : "changelog"} entry ${JSON.stringify(entry.header)}; put intended extra entries in a BEGIN_COMMIT_OVERRIDE block.`,
      );
    }
  }
  return findings;
}

/**
 * Cheap PR-time lint for markup that release-please copies into release notes. It covers the
 * usual forms of its commit grammar without installing it; the release-body CI job, which
 * parses with release-please itself, stays the authoritative check.
 */
export function releaseNoteMarkup(title: string, body: string): string[] {
  const finding = (where: string, snippet: string) =>
    `HTML-like markup in ${where}: ${JSON.stringify(snippet)}. Write placeholders without angle brackets (for example DIR or {dir}), because release-please parses release notes as HTML (#1298).`;
  const findings = snippets(title, false).map((snippet) => finding("title", snippet));
  const normalized = body.replace(/\r\n/g, "\n");
  // A conservative superset of what release-please reads as extra commits: header lines of the
  // standard types in any case, with or without a space after the colon, breaking headers of any
  // type (`security!:`), and whole nested-commit and override blocks.
  const headers = /^(?:(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\(.*?\))?!?|[\w-]+(?:\(.*?\))?!):[^\n]*/gim;
  for (const header of normalized.matchAll(headers)) {
    findings.push(...snippets(header[0], false).map((snippet) => finding("commit header line in the body", snippet)));
  }
  for (const block of normalized.matchAll(/BEGIN_(NESTED_COMMIT|COMMIT_OVERRIDE)[\s\S]*?(?:END_\1|$)/g)) {
    findings.push(...snippets(block[0], false).map((snippet) => finding(`BEGIN_${block[1]} block`, snippet)));
  }
  // Only a truly empty line ends a breaking note; spaces and tabs belong to it. The parser finds
  // `BREAKING-CHANGE:` anywhere in a line, `BREAKING CHANGE:` only at its start.
  for (const footer of normalized.matchAll(/(?:^BREAKING CHANGE:|BREAKING-CHANGE:)[^\n]*(?:\n(?!\n)[^\n]+)*/gm)) {
    findings.push(...snippets(footer[0], false).map((snippet) => finding("BREAKING CHANGE footer", snippet)));
  }
  return findings;
}
