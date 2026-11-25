import { expect, test } from "bun:test";
import { type Catalogs, checkToastCopySource, isShortLabel, readCatalog } from "./toast-copy";

const file = "packages/example/src/frontend/Example.tsx";
const catalogFile = "packages/example/src/frontend/example-messages.ts";
const catalogSource = `import { i18n } from "@k2b/stdlib";
export const exampleMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      sent: "Sent",
      sendingIn: ({ seconds }: { seconds: number }) => \`The message will be sent in \${seconds} s.\`,
      longTitle: "The message could not be sent right now",
      copied: "Link copied",
    },
    de: {
      sent: "Gesendet",
      sendingIn: ({ seconds }) => \`Die Nachricht wird in \${seconds} s gesendet.\`,
      longTitle: "Die Nachricht konnte gerade nicht gesendet werden",
      copied: "Link kopiert",
    },
  },
});
`;
const catalogs: Catalogs = new Map([[catalogFile, readCatalog(catalogFile, catalogSource)]]);
const check = (body: string) =>
  checkToastCopySource(file, `import { exampleMessages } from "./example-messages";\n${body}`, catalogs).map(({ line, key }) => ({
    line,
    kind: key.split(" | ")[1],
  }));

test("a title has at most three words and 32 characters", () => {
  expect(isShortLabel("Gesendet")).toBe(true);
  expect(isShortLabel("Could not save")).toBe(true);
  expect(isShortLabel("Draft could not be saved")).toBe(false);
  expect(isShortLabel("Ausgangspostfachsynchronisierungsfehler")).toBe(false);
});

test("reads both catalogue languages, including message functions with placeholders", () => {
  const entries = readCatalog(catalogFile, catalogSource);
  expect(entries.get("sent")).toEqual(["Sent", "Gesendet"]);
  expect(entries.get("sendingIn")).toEqual(["The message will be sent in X s.", "Die Nachricht wird in X s gesendet."]);
});

test("accepts a short title with a description, and a short message alone", () => {
  expect(check(`toast.success(t().sendingIn({ seconds: 20 }), { title: t().sent });`)).toEqual([]);
  expect(check(`toast("Link copied");\ntoast.success(t().copied);`)).toEqual([]);
  expect(check(`toast.error(error.message, { title: "Not sent", action: { label: "Try again", onClick: retry } });`)).toEqual([]);
});

test("finds prose without a title, a dynamic message without a title, and a long title", () => {
  expect(check(`toast.success(t().sendingIn({ seconds: 20 }));`)).toEqual([{ line: 2, kind: "untitled" }]);
  expect(check(`toast.error(error instanceof Error ? error.message : t().sent);`)).toEqual([{ line: 2, kind: "untitled" }]);
  expect(check(`toast.error("Upload failed", { title: t().longTitle });`)).toEqual([{ line: 2, kind: "title" }]);
  // Either branch of a condition counts.
  expect(check(`toast.success(scheduled ? t().sendingIn({ seconds: 1 }) : t().sent);`)).toEqual([{ line: 2, kind: "untitled" }]);
});

test("finds a tone glyph passed as icon, but allows a glyph that says more", () => {
  expect(check(`toast(t().copied, { iconClass: "ti ti-alert-circle" });`)).toEqual([{ line: 2, kind: "tone-icon" }]);
  expect(check(`toast(t().sendingIn({ seconds: 20 }), { title: t().sent, iconClass: "ti ti-send" });`)).toEqual([]);
});

test("ignores other calls, tests, and the component itself", () => {
  expect(check(`notify(t().sendingIn({ seconds: 20 }));\nhandle.toast?.update("x");`)).toEqual([]);
  expect(checkToastCopySource("packages/example/src/Example.test.tsx", `toast("A whole sentence that explains a lot");`, catalogs)).toEqual(
    [],
  );
  expect(checkToastCopySource("packages/ui/src/feedback/toast.ts", `toast("A whole sentence that explains a lot");`, catalogs)).toEqual([]);
});

test("leaves the one-sentence toast of @k2b/ui/v2 alone, but not v1's toast beside a v2 import", () => {
  const v2 = `import { useToast } from "@k2b/ui/v2";\nconst Example = () => {\n  const toast = useToast();\n  toast("The pairing could not be cancelled. Choose Pair a device again to cancel it.", { status: "bad" });\n};`;
  expect(checkToastCopySource(file, v2, catalogs)).toEqual([]);
  const v1 = `import { Button } from "@k2b/ui/v2";\nimport { toast } from "@k2b/ui";\ntoast.error("The pairing could not be cancelled. Choose Pair a device again to cancel it.");`;
  expect(checkToastCopySource(file, v1, catalogs)).toHaveLength(1);
});
