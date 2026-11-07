import type { GeneratedCodeSdk } from "@k2b/cloud/code";
import { compileScript } from "../../chat-code/runtime/compile";
import { ArtifactCompileError, sourceActions } from "../actions";
import { ArtifactSource } from "../contracts";

export { compilationDiagnostic, resolveSourceImport, runtimeSource } from "../../chat-code/runtime/compile";
export async function compileArtifact(
  input: unknown,
  invocation?: { action: string; input?: unknown },
  sdk?: GeneratedCodeSdk,
  runner = false,
) {
  const source = ArtifactSource.parse(input);
  const actions = sourceActions(source);
  const action = invocation ? actions.find((action) => action.name === invocation.action) : undefined;
  if (invocation && !action) throw new ArtifactCompileError(`Unknown app action: ${invocation.action}`);
  return compileScript(
    { ...source, entry: action?.entry ?? source.entry },
    sdk,
    runner,
    invocation ? (invocation.input ?? null) : undefined,
    !invocation && actions.length > 0 && !source.files.some((file) => file.path === source.entry),
  );
}
/** Compile the script entry and every published handler without running any application code. */
export async function validateArtifact(source: ArtifactSource) {
  if (!source.entry.endsWith(".html")) await compileArtifact(source);
  for (const action of sourceActions(source)) {
    // code_action passes one JSON object. Saved revisions keep compiling; publication rejects uncallable actions.
    if (action.inputSchema.type !== "object")
      throw new ArtifactCompileError(`app.actions.json: ${action.name} inputSchema must have type "object"`);
    await compileArtifact(source, { action: action.name });
  }
}
