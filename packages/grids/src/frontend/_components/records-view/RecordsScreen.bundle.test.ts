import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { cloudLanguageBuild, islandBundleSize } from "../../../../../../scripts/fixtures/island-bundle-size";

// The records island carries a table page's code (until v2 the route island did; the budget and the promises moved with it). Measured with this helper (#3849, Bun 1.4.2): with the barcode drawing
// code eager, 982,764 B for English and 999,105 B for German; on demand, 794,891 B and 811,880 B. The budget is the
// larger value plus about 2 %, rounded up to the next KiB: 809 KiB. It may only go down.
export const GRIDS_ROUTE_EAGER_BROTLI_BUDGET = 809 * 1024;

const entry = resolve(import.meta.dir, "RecordsScreen.island.tsx");

// The size helper cannot measure an island with the v2 workspace navigation yet (#4332); the budget and the on-demand
// promises stand and return with its fix.
test.skip("the records island loads its barcode drawing, Assistant and preview code on demand and stays within its eager budget", async () => {
  for (const language of ["en", "de"]) {
    const size = await islandBundleSize([entry], undefined, cloudLanguageBuild(language));
    console.info(`Grids records eager (${language}): ${size.eagerBrotliBytes}/${GRIDS_ROUTE_EAGER_BROTLI_BUDGET} B Brotli`);
    expect(size.eagerBrotliBytes).toBeLessThanOrEqual(GRIDS_ROUTE_EAGER_BROTLI_BUDGET);
    // The Assistant client and the search preview's block renderer serve one action each (sync 69 found both eager).
    for (const onDemand of [
      /\/barcode-rendering\.ts$/,
      /\/@bwip-js\/generic\//,
      /\/cloud\/src\/ai\/browser\.ts$/,
      /\/cloud\/src\/blocks\/BlockTree\.tsx$/,
    ]) {
      expect(size.dynamicInputs.some((input) => onDemand.test(input))).toBe(true);
      expect(size.eagerInputs.filter((input) => onDemand.test(input))).toEqual([]);
    }
  }
}, 300_000);
