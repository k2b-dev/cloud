import { expect, test } from "bun:test";
import { getPageSwapBuild, type PageSwapParts, pageSwapSignature, registerPageSwap } from "./page-swap";

const shell = {
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
