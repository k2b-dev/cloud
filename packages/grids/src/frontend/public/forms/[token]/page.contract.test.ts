import { describe, expect, test } from "bun:test";

describe("public form page boundary", () => {
  test("projects form and field identifiers before browser hydration", async () => {
    const source = await Bun.file(new URL("./page.tsx", import.meta.url)).text();

    expect(source).toContain('import { toPublicForm } from "../../../../api/form-api-shared"');
    expect(source).toContain('import { toPublicFields } from "../../../../api/public-dto"');
    expect(source).toContain("const fields = await toPublicFields(internalFields)");
    expect(source).toContain("const safeForm = await toPublicForm(form)");
    expect(source).toContain("inlineTargetFields[publicTargetTableId] = await toPublicFields");
    expect(source).toContain("<MinimalLayout c={c}>");
    expect(source).not.toContain("toPublicRenderableForm(form)");
    expect(source).not.toContain("PublicTimezoneCookie");
    expect(source).not.toContain("themeMatch");
  });
});
