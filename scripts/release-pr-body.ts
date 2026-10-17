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

export function releaseNoteMarkup(title: string, body: string): string[] {
  const finding = (where: string, snippet: string) =>
    `HTML-like markup in ${where}: ${JSON.stringify(snippet)}. Write placeholders without angle brackets (for example DIR or {dir}), because release-please parses release notes as HTML (#1298).`;
  const findings = snippets(title, false).map((snippet) => finding("title", snippet));
  for (const paragraph of body.replace(/\r\n/g, "\n").split(/\n[\t ]*\n/)) {
    const footer = /^BREAKING(?: CHANGE|-CHANGE):/m.exec(paragraph);
    if (footer) {
      findings.push(...snippets(paragraph.slice(footer.index), false).map((snippet) => finding("BREAKING CHANGE footer", snippet)));
    }
  }
  return findings;
}
