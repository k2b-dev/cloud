import { z } from "zod";
import { ArtifactPath, type ArtifactSource } from "./contracts";

/** Part of the immutable source revision, never evaluated during discovery. */
export const ACTION_MANIFEST_PATH = "app.actions.json";
const Schema = z.record(z.string(), z.json());
export const AppAction = z.object({
  name: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/).max(80),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  entry: ArtifactPath.refine(path => /\.(js|ts)$/.test(path)),
  inputSchema: Schema,
  outputSchema: Schema,
}).strict();
export type AppAction = z.infer<typeof AppAction>;
const Manifest = z.object({ actions: z.array(AppAction).min(1).max(64) }).strict();

export function actionValidator(schema: AppAction["inputSchema"]) {
  // Use the same JSON Schema implementation as Cloud capabilities. Unsupported
  // schema features fail at publication, rather than becoming silent guesses.
  return z.fromJSONSchema(structuredClone(schema));
}

export class ArtifactCompileError extends Error {
  readonly code = "COMPILE_FAILED";
}

export function sourceActions(source: ArtifactSource): AppAction[] {
  try { return parseSourceActions(source); }
  catch (error) { throw new ArtifactCompileError(`app.actions.json: ${error instanceof Error ? error.message : String(error)}`.slice(0, 16000)); }
}

function parseSourceActions(source: ArtifactSource): AppAction[] {
  const file = source.files.find(file => file.path === ACTION_MANIFEST_PATH);
  if (!file) return [];
  const { actions } = Manifest.parse(JSON.parse(file.content));
  const names = new Set<string>();
  for (const action of actions) {
    if (names.has(action.name)) throw new Error(`Duplicate app action: ${action.name}`);
    names.add(action.name);
    if (!source.files.some(file => file.path === action.entry))
      throw new Error(`Missing action entry: ${action.entry}`);
    actionValidator(action.inputSchema);
    actionValidator(action.outputSchema);
  }
  return actions;
}
