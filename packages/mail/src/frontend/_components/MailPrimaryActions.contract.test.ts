import { describe, expect, test } from "bun:test";

describe("Mail primary actions", () => {
  test("uses the Mail accent for Compose and the composer send or reply action", async () => {
    const [composer, styles] = await Promise.all([
      Bun.file(new URL("./MailComposer.tsx", import.meta.url)).text(),
      Bun.file(new URL("../../styles/app.css", import.meta.url)).text(),
    ]);

    expect(composer).toContain('<SplitButton\n          class="mail-compose-action"');
    expect(styles).toContain("--k2b-action-solid: color-mix(in srgb, var(--app-accent) 80%, black)");
  });
});
