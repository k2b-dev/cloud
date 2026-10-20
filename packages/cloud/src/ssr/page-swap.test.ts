import { expect, test } from "bun:test";
import { getPageSwapBuild, type PageSwapParts, pageSwapSignature, registerPageSwap } from "./page-swap";

const parts: PageSwapParts = {
  app: "mail",
  kind: "app",
  user: "person",
  appSession: false,
  locale: "en",
  theme: undefined,
  providers: ["assistant"],
  apps: ["mail", "files"],
  build: "1:release",
};

test("every persistent document boundary changes the opaque signature", () => {
  const changes: Partial<PageSwapParts>[] = [
    { app: "files" },
    { kind: "anonymous" },
    { user: null },
    { user: "other" },
    { appSession: true },
    { locale: "de" },
    { theme: "dark" },
    { providers: [] },
    { providers: ["other"] },
    { apps: ["files", "mail"] },
    { apps: ["mail"] },
    { build: "2:release" },
  ];
  const signature = pageSwapSignature(parts);
  expect(signature).toMatch(/^[a-f0-9]{32}$/);
  for (const change of changes) expect(pageSwapSignature({ ...parts, ...change })).not.toBe(signature);
});

test("column presentation and context do not change the signature", () => {
  const column = { ...parts, fullPage: true, fullWidth: true, title: "Other", help: ["topic"], scope: { type: "mail", id: "42" } };
  expect(pageSwapSignature(column)).toBe(pageSwapSignature(parts));
});

test("registration belongs only to the opted-in request context", () => {
  const enabled = {};
  registerPageSwap(enabled, "build");
  expect(getPageSwapBuild(enabled)).toBe("build");
  expect(getPageSwapBuild({})).toBeUndefined();
});
