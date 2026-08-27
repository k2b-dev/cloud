import { describe, expect, test } from "bun:test";

const source = await Bun.file(new URL("./LayoutHelp.tsx", import.meta.url)).text();

describe("Layout Help presentation", () => {
  test("uses the shared panel placeholder for document loading feedback", () => {
    expect(source).toContain('class="mx-auto flex min-h-full w-full max-w-7xl flex-col"');
    expect(source).toContain('<Placeholder state="loading" variant="panel" title={t().loading} />');
    expect(source).toContain('import { helpMessages } from "./help-messages";');
  });
});
