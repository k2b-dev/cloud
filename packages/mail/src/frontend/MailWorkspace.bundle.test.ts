import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { islandBundleSize } from "../../../../scripts/fixtures/island-bundle-size";

// Measured with this helper (#3729): 404,565 B on 309c61ccd6 before the split, 343,569 B after it (Bun 1.4.2). With the
// form prompt's fields on demand (#3771): 343,901 B on dda9e40432 before, 325,300 B after. The budget is the after value
// plus about 2 %, rounded up to the next KiB: 325 KiB. It may only go down.
export const MAIL_WORKSPACE_EAGER_BROTLI_BUDGET = 325 * 1024;

test("the Mail workspace island keeps its composer, viewer and dialogs outside its eager budget", async () => {
  const size = await islandBundleSize([resolve(import.meta.dir, "MailWorkspace.island.tsx")]);
  console.info(`Mail workspace eager: ${size.eagerBrotliBytes}/${MAIL_WORKSPACE_EAGER_BROTLI_BUDGET} B Brotli`);
  expect(size.eagerBrotliBytes).toBeLessThanOrEqual(MAIL_WORKSPACE_EAGER_BROTLI_BUDGET);
  for (const onDemand of [
    /\/MailComposer\.tsx$/,
    /\/MailComposerEditor\.tsx$/,
    /\/MailTextEditor\.tsx$/,
    /\/mail-composer-messages\.ts$/,
    /\/MailScheduleDialog\.tsx$/,
    /\/MailActivityDialog\.tsx$/,
    /\/MailBulkTagDialog\.tsx$/,
    /\/mail-remaining-messages\.ts$/,
    /\/content\/Lightbox\.js$/,
    /\/content\/FileView\.js$/,
    /\/layout\/Panes\.js$/,
  ]) {
    expect(size.dynamicInputs.some((input) => onDemand.test(input))).toBe(true);
    expect(size.eagerInputs.filter((input) => onDemand.test(input))).toEqual([]);
  }
}, 120_000);
