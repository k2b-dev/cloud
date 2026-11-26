import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";

const styles = import.meta.dir;
/**
 * Scratch folders below the package's `.cache` (ignored by Git, so a killed run leaves nothing to commit), where the
 * copy resolves `tailwindcss` and `@k2b/ui` from the package as global.css does.
 */
const scratchRoot = resolve(styles, "../../.cache");

/**
 * Core's global.css as a Core from before a change built it: the same sheet without the given files, which the change
 * added (such as `./minimal-layout.css`). Built from a copy in a scratch folder whose relative imports and sources point
 * back into `src/styles`; the folder is removed at once. Test-only.
 */
export const buildOlderGlobal = async (without: readonly string[]): Promise<string> => {
  let source = readFileSync(join(styles, "global.css"), "utf8");
  for (const file of without) {
    const line = `@import "${file}";`;
    if (!source.includes(line)) throw new Error(`global.css no longer imports ${file}.`);
    source = source.replace(line, "");
  }
  // every relative path of the sheet (imports, `@source`) now starts from the scratch folder
  source = source.replace(/(@(?:import|source)\s+")(\.\.?\/)/g, (_, rule: string, dot: string) => `${rule}${join(styles, dot)}/`);
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "older-core-"));
  try {
    const entry = join(scratch, "global.css");
    writeFileSync(entry, source);
    const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
    if (!build.success) throw new AggregateError(build.logs, "Could not build the older global.css.");
    return await build.outputs[0]!.text();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
