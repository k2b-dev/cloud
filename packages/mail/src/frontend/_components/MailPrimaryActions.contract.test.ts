import { describe, expect, test } from "bun:test";

describe("Mail primary actions", () => {
  test("Compose and the composer send or reply action use the shared primary action colour", async () => {
    const [composer, styles] = await Promise.all([
      Bun.file(new URL("./MailComposer.tsx", import.meta.url)).text(),
      Bun.file(new URL("../../styles/app.css", import.meta.url)).text(),
    ]);

    expect(composer).toContain("<SplitButton\n");
    expect(styles).not.toMatch(/--k2b-action-solid(-hover)?\s*:/);
  });
});
