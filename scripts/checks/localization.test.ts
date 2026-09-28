import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./localization";

const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-localization-"));
  try {
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("reports hard-coded prose in a catalog-only frontend", async () => {
  expect(
    await findings({
      "packages/mail/src/frontend/Panel.tsx": [
        "export const Panel = () => (",
        "  <div>",
        "    <Button>Change item</Button>",
        '    <TextInput label="Folder name" />',
        "    <TextInput placeholder={`Search folders`} />",
        "    <a>Download .eml</a>",
        '    <Button aria-label={`Open ${name}`} title={busy ? "Saving changes" : undefined} />',
        '    <p>{expanded() ? "Show less" : "Show more"}</p>',
        "  </div>",
        ");",
        'const failed = () => toast.error("Could not save the view");',
        "const searched = (query: string) => toast.info(query && `Results for “${query}”`);",
      ].join("\n"),
      "packages/mail/src/frontend/options.ts": 'export const options = [{ id: "implicit", label: "Implicit TLS" }];\n',
    }),
  ).toEqual([
    "packages/mail/src/frontend/Panel.tsx:3",
    "packages/mail/src/frontend/Panel.tsx:4",
    "packages/mail/src/frontend/Panel.tsx:5",
    "packages/mail/src/frontend/Panel.tsx:6",
    "packages/mail/src/frontend/Panel.tsx:7",
    "packages/mail/src/frontend/Panel.tsx:7",
    "packages/mail/src/frontend/Panel.tsx:8",
    "packages/mail/src/frontend/Panel.tsx:11",
    "packages/mail/src/frontend/Panel.tsx:12",
    "packages/mail/src/frontend/options.ts:1",
  ]);
});

test("accepts catalog text, single-word labels, examples, and other frontends", async () => {
  expect(
    await findings({
      "packages/mail/src/frontend/Panel.tsx": [
        "export const Panel = () => (",
        '  <div class="flex items-center gap-2" title="Mail">',
        "    <Button>{messages().changeItem}</Button>",
        '    <Select label="TLS" options={[{ id: "starttls", label: "STARTTLS" }]} />',
        '    <TextInput placeholder="example.org, subsidiary.example" />',
        "    <span>Cc/Bcc</span> <span>UID</span>",
        "    <span title={`${sender}: ${subject}`}>{props.subject || messages().noSubject}</span>",
        '    <span>{count() > 1 ? "IMAP" : "SMTP"}</span>',
        "  </div>",
        ");",
        "const failed = () => toast.error(messages().saveFailed);",
      ].join("\n"),
      "packages/mail/src/frontend/messages.ts": [
        'import { i18n } from "@k2b/stdlib";',
        "export const messages = i18n.define({",
        '  baseLocale: "en",',
        '  messages: { en: { title: "Share attachment" }, de: { title: "Anhang freigeben" } },',
        "});",
      ].join("\n"),
      "packages/mail/src/frontend/Panel.render.test.tsx": "const html = <p>Rendered in a test</p>;\n",
      "packages/other/src/frontend/Page.tsx": "export const Page = () => <p>Not yet localized</p>;\n",
    }),
  ).toEqual([]);
});
