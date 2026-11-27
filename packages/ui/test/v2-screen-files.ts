import { readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The whole v2 screens the browser tests render, by file name: the recipes of the k2b-ui skill, which people copy, and
 * the test screens in `test/v2-screens`, which keep every primitive covered but are never shown as an example.
 */
export const v2ScreenFiles = (): ReadonlyMap<string, string> =>
  new Map(
    [resolve(import.meta.dir, "../skills/k2b-ui/recipes"), resolve(import.meta.dir, "v2-screens")]
      .flatMap((dir) =>
        readdirSync(dir)
          .filter((name) => name.endsWith(".tsx"))
          .map((name) => [name, resolve(dir, name)] as const),
      )
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
