import { expect, test } from "bun:test";
import { assertPageSwapPaths, getPageSwap, matchPageSwapScope, type PageSwapParts, pageSwapSignature, registerPageSwap } from "./page-swap";

const shell = {
  themePreference: "system",
  providers: [{ id: "assistant", label: "Assistant", href: "/app/assistant/panel" }],
  apps: [
    { id: "mail", label: "Mail", href: "/app/mail" },
    { id: "files", label: "Files", href: "/app/files" },
  ],
  announcements: 3,
  help: "help-hash",
};
const parts: PageSwapParts = {
  app: "mail",
  kind: "app",
  user: "person",
  appSession: false,
  locale: "en",
  theme: undefined,
  build: "1:release",
  shell,
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
    { build: "2:release" },
    // The kept rail, launchpad, panel and dialogs show these; a reload would show the new ones.
    { shell: { ...shell, providers: [] } },
    { shell: { ...shell, apps: [shell.apps[0]] } },
    { shell: { ...shell, apps: [{ ...shell.apps[0], href: "/app/mail/inbox" }, shell.apps[1]] } },
    { shell: { ...shell, announcements: 4 } },
    { shell: { ...shell, help: "failed" } },
    { shell: { ...shell, themePreference: "dark" } },
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
  expect(getPageSwap(enabled)).toEqual({ build: "build" });
  expect(getPageSwap({})).toBeUndefined();
  const scoped = {};
  registerPageSwap(scoped, "build", "/admin/code");
  expect(getPageSwap(scoped)).toEqual({ build: "build", scope: "/admin/code" });
});

test("an opted-in path covers its pages with the concrete prefix as scope", () => {
  const paths = ["/admin/code", "/app/mail/:mailboxId/code", "/app/assistant/code"];
  expect(matchPageSwapScope(paths, "/admin/code")).toBe("/admin/code");
  expect(matchPageSwapScope(paths, "/admin/code/")).toBe("/admin/code");
  expect(matchPageSwapScope(paths, "/app/mail/VyhBnz/code")).toBe("/app/mail/VyhBnz/code");
  expect(matchPageSwapScope(paths, "/app/mail/VyhBnz/code/catch-up")).toBe("/app/mail/VyhBnz/code");
  expect(matchPageSwapScope(paths, "/app/assistant/code/c_1")).toBe("/app/assistant/code");
  // Only those paths: the rest of the app keeps document loads.
  for (const path of [
    "/admin",
    "/admin/ai",
    "/admin/codes",
    "/app/mail",
    "/app/mail/VyhBnz",
    "/app/mail/VyhBnz/coder",
    "/app/mail//code",
    "/app/assistant",
  ])
    expect(matchPageSwapScope(paths, path)).toBeUndefined();
  // The most specific path wins, so a nested area keeps its own scope.
  expect(matchPageSwapScope(["/admin", "/admin/code"], "/admin/code/x")).toBe("/admin/code");
});

test("pageSwap paths that could never match exactly fail at startup", () => {
  expect(() => assertPageSwapPaths(["/admin/code", "/app/mail/:id/code"])).not.toThrow();
  for (const paths of [[], ["admin"], ["/admin/"], ["/"], ["/app/*/code"], ["/app/:/code"], ["/app/mail?x"]])
    expect(() => assertPageSwapPaths(paths)).toThrow();
});
