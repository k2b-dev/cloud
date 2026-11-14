import { capture, type Finding, type Rule } from "./rule";

/** Visible text only: resource IDs in links and opaque data attributes are navigation, not labels. */
export function codeSurfaceFindings(name: string, text: string): Finding[] {
  const patterns = [
    /\bcode\.tsx?\b/gi,
    /(?<![\w./:-])\b[\w./-]+\.[a-z]{1,8}:\d+(?::\d+)?\b/gi,
    /\bcode_[a-z_]+\b/g,
    /\$\.calls\b/g,
    /\btest\/[^\s]+\.json\b/g,
    /\b(?:sp|c|sa|mb|grid|nb)_[a-z0-9]{4,}\b/gi,
    /\b[0-9a-f]{8,64}\b/gi,
    /\b[0-9a-f]{4}…[0-9a-f]{2}\b/gi,
    /(?:^|[.!?\n]\s*)(?:Passt|OK|Gut|Fertig|Done)(?=$|[.!?\n])/gi,
  ];
  return patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => ({
      file: "scripts/fixtures/code-surfaces.render.ts",
      message: `${name}: visible technical text or an unqualified status: ${JSON.stringify(match[0])}`,
    })),
  );
}
export const rule: Rule = {
  name: "code-no-source",
  description: "Code render fixtures contain no source, technical IDs or unqualified result words outside the two source fields",
  async run({ workspaceRoot }) {
    const result = await capture([process.execPath, "scripts/fixtures/code-surfaces.render.ts"], { cwd: workspaceRoot });
    if (result.code !== 0) return [{ message: `Code surface fixtures failed to render: ${result.output}` }];
    const fixtures: unknown = JSON.parse(result.output);
    if (!Array.isArray(fixtures) || !fixtures.length) return [{ message: "No Code render fixtures were checked." }];
    return fixtures.flatMap((fixture: unknown) => {
      if (
        !fixture ||
        typeof fixture !== "object" ||
        !("name" in fixture) ||
        !("text" in fixture) ||
        typeof fixture.name !== "string" ||
        typeof fixture.text !== "string"
      )
        return [{ message: "Invalid Code render fixture output." }];
      return codeSurfaceFindings(fixture.name, fixture.text);
    });
  },
};
