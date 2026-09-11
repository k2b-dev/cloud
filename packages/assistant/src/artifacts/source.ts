import { compilationDiagnostic, compileArtifact } from "./runtime/compile";
import type { ArtifactSource } from "./contracts";
import type { ArtifactBundle } from "./service";

export async function sourceDiagnostics(source: ArtifactSource) {
  try { await compileArtifact(source); return []; }
  catch (error) { return [compilationDiagnostic(error)]; }
}

export function sourceManifest(bundle: ArtifactBundle) {
  return {
    id: bundle.id, title: bundle.title, description: bundle.description, permission: bundle.permission, entry: bundle.source.entry,
    files: bundle.source.files.map((file) => ({ path: file.path, length: file.content.length })),
  };
}
