import { describe, expect, test } from "bun:test";
import { CUSTOM_APP_REFERENCE, CustomAppDefinitionSchema } from "./contracts";
import { customAppNavigationHref, customAppNavigationParams } from "./routing";

const withNavigationRecord = (recordId: string) => ({
  ...CUSTOM_APP_REFERENCE.example,
  pages: CUSTOM_APP_REFERENCE.example.pages.map((page, index) =>
    index === 1 ? { ...page, navigation: { ...page.navigation, visible: true, recordId } } : page,
  ),
});

describe("static custom app record navigation", () => {
  test("opens the known public record through the existing parameter route", () => {
    const definition = CustomAppDefinitionSchema.parse(withNavigationRecord("REC001"));
    const page = definition.pages[1]!;
    expect(page.record).toBeDefined();
    expect(customAppNavigationParams(page)).toEqual({ [page.record!.id.path]: "REC001" });
    expect(customAppNavigationHref("APP001", page)).toBe(`/apps/APP001/${page.id}?${page.record!.id.path}=REC001`);
    const home = definition.pages[0]!;
    expect(customAppNavigationParams(home)).toEqual({});
    expect(customAppNavigationHref("APP001", home)).toBe(`/apps/APP001/${home.id}`);
  });

  test("requires a bound record page and a public record identity", () => {
    expect(CustomAppDefinitionSchema.safeParse(withNavigationRecord("00000000-0000-4000-8000-000000000001")).success).toBe(false);
    const input = withNavigationRecord("REC001");
    input.pages[0] = { ...input.pages[0]!, navigation: { visible: true, recordId: "REC001" } };
    expect(CustomAppDefinitionSchema.safeParse(input).success).toBe(false);
  });

  test("does not infer missing parameters or allow a parameterized start page", () => {
    const input = withNavigationRecord("REC001");
    expect(CustomAppDefinitionSchema.safeParse({ ...input, startPageId: input.pages[1]!.id }).success).toBe(false);
    const page = input.pages[1]!;
    expect(
      CustomAppDefinitionSchema.safeParse({
        ...input,
        pages: [input.pages[0], { ...page, navigation: { visible: true } }],
      }).success,
    ).toBe(false);
  });
});
