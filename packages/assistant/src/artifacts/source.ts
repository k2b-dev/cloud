import type { ArtifactSource } from "./contracts";
import { stepsProblem } from "./html/check-contracts";
import { lintSource } from "./html/compose";
import { compilationDiagnostic, compileArtifact, validateArtifact } from "./runtime/compile";
import type { ArtifactBundle } from "./service";

/** Compiler messages for scripts and actions; for an HTML app also the static findings of its JavaScript and CSS. */
export async function sourceDiagnostics(source: ArtifactSource) {
  const diagnostics: string[] = [];
  if (source.entry.endsWith(".html")) {
    const files = Object.fromEntries(source.files.map((file) => [file.path, file.content]));
    for (const file of source.files)
      if (/\.(?:js|mjs|css)$/.test(file.path))
        for (const issue of lintSource(file.path, file.content, files))
          diagnostics.push(`${issue.severity} ${issue.where ?? file.path}: ${issue.message}`);
    // code_check would refuse it; say so while the file is being written.
    const steps = stepsProblem(source.files);
    if (steps) diagnostics.push(`error steps.json: ${steps}`);
  }
  try {
    // An HTML interface is not compiled; its actions are.
    await (source.entry.endsWith(".html") ? validateArtifact(source) : compileArtifact(source));
  } catch (error) {
    diagnostics.push(compilationDiagnostic(error));
  }
  return diagnostics;
}

export function sourceManifest(bundle: ArtifactBundle) {
  return {
    kind: bundle.kind,
    id: bundle.id,
    revision: bundle.revision,
    icon: bundle.icon,
    publishedVersion: bundle.publishedVersion,
    title: bundle.title,
    description: bundle.description,
    permission: bundle.permission,
    entry: bundle.source.entry,
    files: bundle.source.files.map((file) => ({ path: file.path, length: file.content.length })),
  };
}
