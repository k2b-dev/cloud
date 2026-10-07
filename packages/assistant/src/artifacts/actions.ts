import { z } from "zod";
import { ArtifactPath, type ArtifactSource } from "./contracts";

/** Part of the immutable source revision, never evaluated during discovery. */
export const ACTION_MANIFEST_PATH = "app.actions.json";
const Schema = z.record(z.string(), z.json());
export const AppAction = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-zA-Z0-9_]*$/)
      .max(80),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(2000),
    entry: ArtifactPath.refine((path) => /\.(js|ts)$/.test(path)),
    inputSchema: Schema,
    outputSchema: Schema,
  })
  .strict();
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

/** A call input that its action's schema rejects; the action did not run. */
export class ActionInputError extends Error {
  readonly code = "ACTION_INPUT_INVALID";
}

// anyOf/oneOf report one issue per alternative; expand them so the leaf fields stay named.
const describeIssues = (issues: readonly z.core.$ZodIssue[], prefix: readonly PropertyKey[] = []): string[] =>
  issues.map((issue) => {
    const path = [...prefix, ...issue.path];
    const field = path.length ? path.map(String).join(".") : "input";
    if (issue.code !== "invalid_union" || !issue.errors.length) return `${field}: ${issue.message}`;
    return `${field}: matches no alternative: ${issue.errors.map((branch) => `[${describeIssues(branch, path).join("; ")}]`).join(" or ")}`;
  });

export function parseActionInput(action: AppAction, input: unknown) {
  const result = actionValidator(action.inputSchema).safeParse(input);
  if (result.success) return result.data;
  const issues = describeIssues(result.error.issues).join("; ");
  // Same bound as manifest diagnostics; nested unions can multiply the listed alternatives.
  throw new ActionInputError(`Input for ${action.name} does not match its inputSchema; the action did not run. ${issues}`.slice(0, 16000));
}

export function sourceActions(source: ArtifactSource): AppAction[] {
  try {
    return parseSourceActions(source);
  } catch (error) {
    throw new ArtifactCompileError(`app.actions.json: ${error instanceof Error ? error.message : String(error)}`.slice(0, 16000));
  }
}

function parseSourceActions(source: ArtifactSource): AppAction[] {
  const file = source.files.find((file) => file.path === ACTION_MANIFEST_PATH);
  if (!file) return [];
  const { actions } = Manifest.parse(JSON.parse(file.content));
  const names = new Set<string>();
  for (const action of actions) {
    if (names.has(action.name)) throw new Error(`Duplicate app action: ${action.name}`);
    names.add(action.name);
    if (!source.files.some((file) => file.path === action.entry)) throw new Error(`Missing action entry: ${action.entry}`);
    actionValidator(action.inputSchema);
    actionValidator(action.outputSchema);
  }
  return actions;
}
