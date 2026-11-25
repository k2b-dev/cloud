import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { cloudLanguageBuild, islandBundleSize } from "../../../../scripts/fixtures/island-bundle-size";

// The v2 pilot's island loads only for people in the pilot. Like v1's island it keeps the composer, its editor and
// the dialogs on demand; the v1 island loads none of v2 (MailWorkspace.bundle.test.ts keeps its budget).
const entry = resolve(import.meta.dir, "MailWorkspaceV2.island.tsx");

test("the Mail v2 pilot island keeps its composer and editor on demand", async () => {
  const size = await islandBundleSize([entry], undefined, cloudLanguageBuild("de"));
  console.info(`Mail v2 pilot eager (de): ${size.eagerBrotliBytes} B Brotli`);
  for (const onDemand of [/\/MailComposer\.tsx$/, /\/MailComposerEditor\.tsx$/, /\/MailTextEditor\.tsx$/, /\/mail-attachments-zip\.ts$/]) {
    expect(size.dynamicInputs.some((input) => onDemand.test(input))).toBe(true);
    expect(size.eagerInputs.filter((input) => onDemand.test(input))).toEqual([]);
  }
  // The composer frame comes from its own entry, never with the whole editor package.
  expect(size.eagerInputs.filter((input) => /\/packages\/editor\/src\/index\.ts$/.test(input))).toEqual([]);
}, 180_000);

test("the v1 island loads none of the v2 pilot", async () => {
  const size = await islandBundleSize([resolve(import.meta.dir, "MailWorkspace.island.tsx")], undefined, cloudLanguageBuild("de"));
  expect(size.eagerInputs.filter((input) => /\/_components\/v2\/|\/ui\/[^/]+\/v2\/|\/editor\/src\/Composer\.tsx$/.test(input))).toEqual([]);
}, 180_000);
