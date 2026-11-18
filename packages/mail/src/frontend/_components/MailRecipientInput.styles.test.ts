import { expect, test } from "bun:test";

test("Mail recipients use plain text, a surface-free remove action, and semantic error ink", async () => {
  const [component, styles] = await Promise.all([
    Bun.file(new URL("./MailRecipientInput.tsx", import.meta.url)).text(),
    Bun.file(new URL("../../styles/app.css", import.meta.url)).text(),
  ]);
  expect(component).not.toMatch(/class="chip mail-recipient/);
  expect(component).toContain('variant="text"');
  expect(component).toContain("enabled:hover:!text-[var(--k2b-danger-text)]");
  expect(component).toContain("focus-visible:!text-[var(--k2b-danger-text)]");
  expect(component).toContain("text-xs outline-none placeholder:text-xs");
  expect(styles).not.toContain(".mail-recipient-pill-shell:has(:focus-visible)");
  expect(styles).toMatch(/\.mail-recipient-pill:focus-visible\s*\{[^}]*box-shadow: var\(--ui-focus\)/);
  expect(styles).toMatch(/\.mail-recipient-control\[data-invalid="true"\] input\s*\{\s*color: var\(--k2b-danger-text\)/);
});
