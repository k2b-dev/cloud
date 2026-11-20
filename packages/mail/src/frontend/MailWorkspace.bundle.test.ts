import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { cloudLanguageBuild, islandBundleSize } from "../../../../scripts/fixtures/island-bundle-size";

// Measured with this helper (#3729): 404,565 B on 309c61ccd6 before the split, 343,569 B after it (Bun 1.4.2). With the
// form prompt's fields on demand (#3771): 343,901 B on dda9e40432 before, 325,300 B after. Since #3770 a page loads
// its language's build: on top of #3771, 302,286 B for English and 306,791 B for German. The budget is the larger
// value plus about 2 %, rounded up to the next KiB: 306 KiB. It may only go down.
export const MAIL_WORKSPACE_EAGER_BROTLI_BUDGET = 306 * 1024;

const entry = resolve(import.meta.dir, "MailWorkspace.island.tsx");

test("the Mail workspace island keeps its composer, viewer and dialogs outside its eager budget", async () => {
  for (const [language, shipped, other] of [
    ["en", "Move to folder", "In Ordner verschieben"],
    ["de", "In Ordner verschieben", "Move to folder"],
  ] as const) {
    const size = await islandBundleSize([entry], undefined, cloudLanguageBuild(language));
    console.info(`Mail workspace eager (${language}): ${size.eagerBrotliBytes}/${MAIL_WORKSPACE_EAGER_BROTLI_BUDGET} B Brotli`);
    expect(size.eagerBrotliBytes).toBeLessThanOrEqual(MAIL_WORKSPACE_EAGER_BROTLI_BUDGET);
    // Each language's build ships its own messages and not the other language's.
    expect(size.eagerText).toContain(shipped);
    expect(size.eagerText).not.toContain(other);
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
  }
}, 180_000);
