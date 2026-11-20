import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { cloudLanguageBuild, islandBundleSize } from "../../../../../../scripts/fixtures/island-bundle-size";

// A table page's own islands: the route and the navigation. Measured with this helper (#3849): BEFORE_PLACEHOLDER
export const GRIDS_TABLE_EAGER_BROTLI_BUDGET = 0;

const entries = ["GridsRoute.island.tsx", "GridsNavigation.island.tsx"].map((file) => resolve(import.meta.dir, file));

test("a Grids table page loads its barcode drawing code on demand and stays within its eager budget", async () => {
  for (const language of ["en", "de"]) {
    const size = await islandBundleSize(entries, undefined, cloudLanguageBuild(language));
    console.info(`Grids table eager (${language}): ${size.eagerBrotliBytes}/${GRIDS_TABLE_EAGER_BROTLI_BUDGET} B Brotli`);
    expect(size.eagerBrotliBytes).toBeLessThanOrEqual(GRIDS_TABLE_EAGER_BROTLI_BUDGET);
    for (const onDemand of [/\/barcode-rendering\.ts$/, /\/@bwip-js\/generic\//]) {
      expect(size.dynamicInputs.some((input) => onDemand.test(input))).toBe(true);
      expect(size.eagerInputs.filter((input) => onDemand.test(input))).toEqual([]);
    }
  }
}, 300_000);
