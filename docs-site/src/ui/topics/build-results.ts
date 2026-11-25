import { join } from "node:path";
import { type PropsDoc, referenceFile, type UiV2Reference } from "./build-time";

export type { PropRow, PropsDoc } from "./build-time";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isReference = (value: unknown): value is UiV2Reference => isRecord(value) && isRecord(value.recipes) && isRecord(value.props);

/**
 * The recipes of the skill `k2b-ui` and the props of `@k2b/ui/v2`. Development and tests read them from the
 * repository at start, so a changed recipe or TSDoc shows at the next start; production reads the file its build wrote.
 */
const load = async (): Promise<UiV2Reference> => {
  if (process.env.NODE_ENV !== "production") return (await import("./build-time")).uiV2Reference();
  const parsed: unknown = await Bun.file(join(import.meta.dir, referenceFile)).json();
  if (!isReference(parsed)) throw new Error(`${referenceFile} beside the server is no UI v2 reference; rebuild the site`);
  return parsed;
};

const reference = await load();

/** The text of every recipe file by its name without `.tsx`. */
export const recipeSource: Readonly<Record<string, string>> = reference.recipes;

/** The props of every part of `@k2b/ui/v2` and of its exported object types, by name (`Table`, `Pane.Split`, `Column`). */
export const v2Props: Readonly<Record<string, PropsDoc>> = reference.props;

/** Where the recipe files live in the repository. */
export const recipesPath = "packages/ui/skills/k2b-ui/recipes";
