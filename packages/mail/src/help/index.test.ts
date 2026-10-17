import { describe, expect, test } from "bun:test";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { compileWorkflow } from "@k2b/cloud/workflows/language";
import { z } from "zod";
import mailCli from "../cli";
import {
  composeTemplateVariables,
  createAutomaticReplyConfigurationSchema,
  createIncomingAutomationSchema,
  draftEditableContentInputSchema,
} from "../contracts";
import { mailConversationUiMessages } from "../frontend/_components/mail-conversation-ui-messages";
import { mailRemainingMessages } from "../frontend/_components/mail-remaining-messages";
import { mailSettingsMessages } from "../frontend/_components/mail-settings-messages";
import { mailboxAccessLevels } from "../frontend/_components/mailbox-access-levels";
import { mailWorkspaceMessages } from "../frontend/mail-workspace-messages";
import { bindMailWorkflow } from "../workflows/binder";
import { buildMailWorkflowCatalog } from "../workflows/catalog";
import { mailWorkflows } from "../workflows/module";
import { mailHelp } from ".";

const cliAutomationReference = await Bun.file(new URL("../cli-references/automation.md", import.meta.url)).text();
const cliMailReferences = await Promise.all(
  ["index.md", "compose.md", "automation.md", "operations.md"].map((file) =>
    Bun.file(new URL(`../cli-references/${file}`, import.meta.url)).text(),
  ),
);

const renderMailCliHelp = async (path: string[]): Promise<string> => {
  const lines: string[] = [];
  const unavailable = () => {
    throw new Error("CLI help unexpectedly executed a command");
  };
  const context = {
    args: [...path, "help"],
    flags: {},
    options: { profile: "", server: "", token: "", output: "text" },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: unavailable,
    fetch: unavailable,
    readJson: unavailable,
    print: (value = "") => lines.push(value),
    write: async () => undefined,
    error: unavailable,
    json: unavailable,
    jsonLine: unavailable,
    table: unavailable,
  } as unknown as CloudCliContext;
  await mailCli.run(context);
  return lines.join("\n");
};

const registeredMailCliCommands = async (): Promise<Map<string, string>> => {
  const commands = new Map<string, string>();
  const visit = async (path: string[]): Promise<void> => {
    const help = await renderMailCliHelp(path);
    const commandSection = help.match(/\nCommands:\n([\s\S]*?)(?:\n\S|$)/)?.[1] ?? "";
    const children = [...commandSection.matchAll(/^  (\S+)\s+/gm)].map((match) => match[1]!);
    const command = path.join(" ");
    if (path.length > 0 && (children.length === 0 || help.includes(`  cld mail ${command} [options]`))) commands.set(command, help);
    for (const child of children) await visit([...path, child]);
  };
  await visit([]);
  return commands;
};

const manifestTerms = (schema: unknown): string[] => {
  if (!schema || typeof schema !== "object") return [];
  const value = schema as {
    properties?: unknown;
    enum?: unknown;
    const?: unknown;
    items?: unknown;
    variants?: unknown;
    oneOf?: unknown;
    anyOf?: unknown;
    allOf?: unknown;
    $defs?: unknown;
  };
  const terms: string[] = [];
  if (value.properties && typeof value.properties === "object") {
    for (const [key, child] of Object.entries(value.properties)) terms.push(key, ...manifestTerms(child));
  }
  if (Array.isArray(value.enum)) terms.push(...value.enum.filter((entry): entry is string => typeof entry === "string"));
  if (typeof value.const === "string") terms.push(value.const);
  if (value.items) terms.push(...manifestTerms(value.items));
  for (const variants of [value.variants, value.oneOf, value.anyOf, value.allOf]) {
    if (Array.isArray(variants)) for (const variant of variants) terms.push(...manifestTerms(variant));
  }
  if (value.$defs && typeof value.$defs === "object") {
    for (const definition of Object.values(value.$defs)) terms.push(...manifestTerms(definition));
  }
  return terms;
};

const workflowCatalog = () =>
  buildMailWorkflowCatalog({
    folders: [{ id: "10000000-0000-4000-8000-000000000001", name: "Invoices" }],
    assignableUsers: [{ id: "20000000-0000-4000-8000-000000000001", name: "Alice Example" }],
    senderIdentities: [{ id: "40000000-0000-4000-8000-000000000001", name: "Support" }],
    localTags: [
      { id: "50000000-0000-4000-8000-000000000001", name: "Finance" },
      { id: "50000000-0000-4000-8000-000000000002", name: "Urgent" },
    ],
  });

const expectedIds = [
  "mail-start",
  "mail-work",
  "mail-compose",
  "mail-security",
  "mail-collaboration",
  "mail-admin",
  "mail-automation",
  "mail-workflows",
  "mail-troubleshooting",
];

describe("mailHelp", () => {
  test("documents the separate signature choice and CSS selectors in both languages", () => {
    const english = mailHelp.getMarkdown("mail-compose");
    const german = mailHelp.getMarkdown("mail-compose", "de");
    expect(english).toContain("**Signature** button between **Write with AI** and **Options**");
    expect(english).toContain("**No signature**");
    expect(english).toContain("Switching the sender switches to that sender's default");
    expect(english).toContain("search snippets only");
    expect(german).toContain("**Signatur** zwischen **Mit KI schreiben** und **Optionen**");
    expect(german).toContain("**Keine Signatur**");
    expect(german).toContain("Signaturen bleiben vom bearbeitbaren Text getrennt");
    for (const locale of ["en", "de"]) expect(mailHelp.getMarkdown("mail-admin", locale)).toContain(".mail-signature { color: #52525b; }");
  });
  test("compose template create help marks required flags and describes every variable", async () => {
    const help = await renderMailCliHelp(["compose", "template", "create"]);
    for (const flag of ["kind", "name", "shortcut", "body"]) {
      const line = help.split("\n").find((line) => line.trimStart().startsWith(`--${flag} `));
      expect(line).toContain("Required.");
    }
    for (const [name, description] of Object.entries(composeTemplateVariables)) {
      const line = help.split("\n").find((line) => line.trimStart().startsWith(`${name} `));
      expect(line).toContain(description);
    }
    expect(help).toContain('To separate list items such as message.to, use join: {{ message.to | join: ", " }}');
    expect(help).toContain("--shortcut sig --body-file signature.md");
  });

  test("compose template update help describes every variable", async () => {
    const help = await renderMailCliHelp(["compose", "template", "update"]);
    for (const [name, description] of Object.entries(composeTemplateVariables)) {
      const line = help.split("\n").find((line) => line.trimStart().startsWith(`${name} `));
      expect(line).toContain(description);
    }
  });

  test.each(["compose preview", "compose snippet render", "compose suggestions"])(
    "%s help shows a draft JSON example that matches the contract",
    async (command) => {
      const help = await renderMailCliHelp(command.split(" "));
      expect(help).toContain("senderIdentityId is required");
      expect(help).toContain("cld mail identity list");
      expect(help).toContain(
        '  to, cc, and bcc are arrays of { "address": string, "name"?: string|null } objects, not plain strings; name is optional; default [].',
      );
      expect(help).toContain("--draft-file draft.json");
      expect(help).toContain("Example draft.json:");
      const example = help.match(/^  \{\n[\s\S]*?^  \}/m)?.[0];
      expect(example).toBeDefined();
      if (!example) throw new Error("Draft JSON example is missing from compose help");
      const parsed = draftEditableContentInputSchema.parse(JSON.parse(example));
      expect(parsed).toMatchObject({
        senderIdentityId: "Ident1",
        to: [{ name: null, address: "recipient@example.com" }],
        cc: [],
        bcc: [],
        subject: "Example",
        body: "Hello",
        format: "markdown",
        priority: "normal",
        requestDeliveryReceipt: false,
        requestReadReceipt: false,
      });
    },
  );

  test.each([
    "../cli-references/compose.md",
    "./documents/en/mail-compose.help.md",
    "./documents/de/mail-compose.help.md",
    "../../../../docs-site/apps-content/en/mail.md",
  ])("%s documents every compose template variable", async (file) => {
    const document = await Bun.file(new URL(file, import.meta.url)).text();
    const lines = document.split("\n");
    const headers = lines.filter((line) => line.startsWith("| Variable |"));
    if (headers.length === 0) throw new Error(`Compose variable table header is missing in ${file}`);
    expect(headers).toHaveLength(1);
    const headerIndex = lines.findIndex((line) => line.startsWith("| Variable |"));
    const rows: [string, string][] = [];
    for (const line of lines.slice(headerIndex + 2)) {
      if (!line.startsWith("|")) break;
      const match = line.match(/^\| `([^`]+)` \| (.*) \|$/);
      if (!match) throw new Error(`Invalid compose variable table row in ${file}: ${line}`);
      rows.push([match[1]!, match[2]!]);
    }
    const names = rows.map(([name]) => name);
    expect(names).toEqual(Object.keys(composeTemplateVariables));
    if (file !== "./documents/de/mail-compose.help.md") expect(Object.fromEntries(rows)).toEqual(composeTemplateVariables);
  });

  test("owns the task-oriented Mail help collection", () => {
    expect(mailHelp.documents.map((document) => document.id)).toEqual(expectedIds);

    const expectedContent = new Map([
      ["mail-start", "Mail organizes email around **mailboxes**"],
      ["mail-work", "Use **Search mailbox** for a quick search"],
      ["mail-compose", "Only the session that currently holds the editing lease can change the draft"],
      ["mail-collaboration", "Internal comments are visible to people who can read the mailbox"],
      ["mail-security", "Mail keeps uncertain signals quiet"],
      ["mail-admin", "Pause mailbox** stops incoming synchronization"],
      ["mail-automation", "Reference-number settings define the format"],
      ["mail-workflows", "Mail workflow YAML has three top-level keys"],
      ["mail-troubleshooting", 'Sending says "Mailbox transport is paused"'],
    ]);

    for (const [id, text] of expectedContent) {
      expect(mailHelp.getMarkdown(id)).toContain(text);
    }
    expect(mailHelp.getMarkdown("mail-compose")).toContain("Choose **Write with AI**");
    expect(mailHelp.getMarkdown("mail-compose")).toContain("does not gain additional mailbox access");
    expect(mailHelp.getMarkdown("mail-work")).toContain("section for the conversation as a whole");
    expect(mailHelp.getMarkdown("mail-work")).toContain("**Everything** is selected by default");
    expect(mailHelp.getMarkdown("mail-work")).toContain("default broad search includes that extracted attachment text");
    expect(mailHelp.getMarkdown("mail-work")).toContain("opens the exact message that owns it");
    expect(mailHelp.getMarkdown("mail-troubleshooting")).toContain("Attachment extraction never blocks receiving");
  });

  test("translates every article to German with matching metadata and locale fallback", () => {
    const english = mailHelp.documentsByLocale?.en ?? [];
    const german = mailHelp.documentsByLocale?.de ?? [];

    expect(german.map((document) => document.id)).toEqual(english.map((document) => document.id));
    for (const document of german) {
      const base = english.find((candidate) => candidate.id === document.id);
      expect(base).toBeDefined();
      expect(document.icon).toBe(base!.icon!);
      expect(document.order).toBe(base!.order);
    }

    expect(mailHelp.getMarkdown("mail-start", "de-CH")).toContain("Mail spiegelt E-Mails");
    expect(mailHelp.getMarkdown("mail-workflows", "de")).toContain("Mail-Workflow-YAML");
    expect(mailHelp.getMarkdown("mail-automation", "de")).toContain("**Administration → Systembeobachtung → Workflows**");
    expect(mailHelp.getMarkdown("mail-automation", "de")).not.toContain("**Admin > ");
    expect(mailHelp.getMarkdown("mail-start", "fr")).toBe(mailHelp.getMarkdown("mail-start")!);
  });

  test("documents several assignees and access to assigned conversations only with the interface labels", () => {
    for (const locale of ["en", "de"] as const) {
      const collaboration = mailHelp.getMarkdown("mail-collaboration", locale)!;
      const work = mailHelp.getMarkdown("mail-work", locale)!;
      const admin = mailHelp.getMarkdown("mail-admin", locale)!;
      const t = mailWorkspaceMessages.resolve([locale]).t;
      for (const label of [t.assignToMe, t.removeMe, t.unassign]) {
        expect(collaboration).toContain(`**${label}**`);
        expect(work).toContain(`**${label}**`);
      }
      const levels = mailboxAccessLevels(locale)({ type: "user", userId: "00000000-0000-4000-8000-000000000000" });
      const scoped = levels.flatMap((level) => (typeof level === "object" && level.scope === "assigned" ? [level.label!] : []));
      expect(scoped).toHaveLength(2);
      for (const label of scoped) {
        expect(collaboration).toContain(`**${label}**`);
        expect(admin).toContain(`**${label}**`);
      }
      expect(collaboration).toContain("20");
      expect(collaboration).toContain('{icon="user-check"}');
      expect(mailHelp.getMarkdown("mail-workflows", locale)).toContain("`assigneeUserIds`");
    }
    const work = mailHelp.getMarkdown("mail-work")!;
    expect(work).toContain("The assignees of both conversations stay assigned");
    expect(work).toContain("a new conversation with the same assignees");
    expect(work).not.toContain("unassigned conversation");
    expect(work).toContain("**Remove all assignees** has no **Undo**");
  });

  test("quotes the German labels of the delivery control, folder discovery, and workflow limits", () => {
    const german = (id: string) => mailHelp.getMarkdown(id, "de")!;
    const delivery = mailConversationUiMessages.resolve(["de"]).t;
    const compose = german("mail-compose");
    expect(compose).toContain(`**${delivery.couldNotSend}:**`);
    expect(compose).toContain(`**${delivery.deliveryUnclear}:**`);
    expect(compose).not.toContain("Konnte nicht gesendet werden");
    expect(compose).not.toContain("Versandstatus unklar");

    const all = expectedIds.map(german).join("\n");
    expect(all).toContain(mailSettingsMessages.resolve(["de"]).t.folderDiscovery);
    expect(all).toContain(`**${mailRemainingMessages.resolve(["de"]).t.effectBudget}**`);
    for (const variant of ["Ordnererkennung", "Wirkungsbudget", "Effektbudget", "Nachbearbeitung", "Backfill", "**Alle Nachrichten**"]) {
      expect(all).not.toContain(variant);
    }
    expect(mailHelp.getMarkdown("mail-automation")).toContain(`**${mailRemainingMessages.resolve(["en"]).t.effectBudget}**`);
  });

  test("says that a default calendar Space never imports invitations automatically", () => {
    expect(mailHelp.getMarkdown("mail-admin")).toContain("does not import invitations automatically");
    expect(mailHelp.getMarkdown("mail-admin", "de")).toContain("importiert keine Einladungen automatisch");
  });

  test("documents permission-scoped Contacts context", () => {
    const collaboration = mailHelp.getMarkdown("mail-collaboration");
    expect(collaboration).toContain("Multiple Contacts can match the same address");
    expect(collaboration).toContain("New contact");
    expect(collaboration).toContain("choose a writable contact book");
    expect(collaboration).toContain("Mail creates the Contact there");
    expect(collaboration).not.toContain("opens in a new tab");
    expect(collaboration).toContain("Mail stores no Contact ownership");
    expect(collaboration).toContain("cld mail conversation related");
    expect(collaboration).toContain("contact-history");
  });

  test("keeps every internal help link on a registered Mail topic", () => {
    const registered = new Set(expectedIds);
    for (const id of expectedIds) {
      const markdown = mailHelp.getMarkdown(id);
      expect(markdown).toBeDefined();
      const links = markdown!.matchAll(/\/app\/mail\/help\/([a-z0-9-]+)/g);
      for (const link of links) expect(registered.has(link[1]!)).toBe(true);
    }
  });

  test("registers Help once at the Mail app boundary", async () => {
    const routes = [
      "../frontend/page.tsx",
      "../frontend/compose/page.tsx",
      "../frontend/[mailboxId]/page.tsx",
      "../frontend/[mailboxId]/automations/page.tsx",
      "../frontend/[mailboxId]/automations/replies/page.tsx",
      "../frontend/[mailboxId]/automations/incoming/page.tsx",
      "../frontend/[mailboxId]/automations/activity/page.tsx",
      "../frontend/[mailboxId]/automations/workflows/page.tsx",
      "../frontend/[mailboxId]/compose/[draftId]/page.tsx",
    ];

    const entry = await Bun.file(new URL("../index.ts", import.meta.url)).text();
    expect(entry).toContain("help: mailHelp");
    for (const route of routes) {
      const source = await Bun.file(new URL(route, import.meta.url)).text();
      expect(source).not.toContain("MailLayoutHelp");
    }
  });

  test("indexes operational recovery topics for registered Help search", () => {
    const ids = mailHelp.documents.filter((document) => document.searchText.includes("paused")).map((document) => document.id);
    expect(ids).toContain("mail-admin");
    expect(ids).toContain("mail-troubleshooting");
  });

  test("documents public-link controls and queued storage snapshots", () => {
    const admin = mailHelp.getMarkdown("mail-admin");
    const work = mailHelp.getMarkdown("mail-work");

    expect(admin).toContain("You need **Manage** access to the mailbox to create, list, or revoke a public attachment link");
    expect(admin).toContain("public URL is disclosed only once");
    expect(admin).toContain("optional password, expiry time, and maximum number of download sessions");
    expect(admin).toContain("including older active links");
    expect(admin).toContain("Only Cloud administrators can open **Admin → Mail**");
    expect(admin).toContain("Refresh storage snapshot** queues a background reconciliation");
    expect(admin).toContain("continue to show the last completed snapshot until that job finishes");
    expect(admin).toContain("cld mail admin mailbox access list|grant|set|revoke");
    expect(work).toContain("Mailbox tools → Shared links");
  });

  test("documents the permission-safe message inspector and exact source export", () => {
    const work = mailHelp.getMarkdown("mail-work");

    expect(work).toContain("Inspect an individual message");
    expect(work).toContain("Download .eml");
    expect(work).toContain("complete byte-exact file");
    expect(work).toContain("Raw headers and `.eml` files can contain private");
    expect(work).toContain("source and `.eml` download are unavailable");
    expect(work).toContain("Spam diagnostics");
    expect(work).toContain("Cloud does not calculate or infer its own spam score");
    expect(work).toContain("Provider keywords");
    expect(work).toContain("Use local tags for normal labeling");
    expect(work).toContain("does not offer provider-keyword editing");
  });

  test("documents safe HTML reading and the personal plain-text alternative", () => {
    const work = mailHelp.getMarkdown("mail-work");
    const admin = mailHelp.getMarkdown("mail-admin");

    expect(work).toContain("stays unread in already open tabs");
    expect(work).toContain("View as plain text");
    expect(work).toContain("Show original colors");
    expect(work).toContain("HTML with original colors");
    expect(work).toContain("shows the HTML version of a message and adapts its colors to dark mode");
    expect(work).toContain("Settings → Reading → Default message format");
    expect(work).toContain("Scripts, forms, embedded objects, external stylesheets");
    expect(admin).toContain("Reading** is available to every mailbox reader");
  });

  test("explains phishing protection without requiring protocol knowledge", () => {
    const security = mailHelp.getMarkdown("mail-security");

    expect(security).toContain("Report phishing");
    expect(security).toContain("Mail keeps uncertain signals quiet");
    expect(security).toContain("does not upload or copy the subject or message body");
    expect(security).toContain("Trusted authentication results");
    expect(security).toContain("A pass for an unrelated domain is ignored");
    expect(security).toContain("does not move messages at the provider or start, cancel, or duplicate automation runs");
  });

  test("documents unified incoming automations and resumable deterministic backfills", () => {
    const automation = mailHelp.getMarkdown("mail-automation");
    const work = mailHelp.getMarkdown("mail-work");

    expect(automation).toContain("Automations → Incoming mail");
    expect(automation).toContain("All incoming mail");
    expect(automation).toContain("mail automation catalog");
    expect(automation).toContain("shows it read-only in the editor");
    expect(automation).toContain("resumable backfill");
    expect(automation).toContain("skips messages already accepted");
    expect(automation).toContain("shared workflow runtime");
    expect(automation).toContain("AI classify many");
    expect(automation).toContain("AI results remain normal workflow outputs");
    expect(automation).toContain("Reply drafts and internal comments are normal Mail steps");
    expect(automation).toContain("never sends them");
    expect(work).toContain("Find all from this sender");
    expect(work).not.toContain("Mark all as read");
    expect(work).toContain("Manage unsubscribe");
    expect(work).toContain("Mailbox tools → Mailing lists");
    expect(work).toContain("Everyone who can view the mailbox");
    expect(work).toContain("Unsubscribe and cleanup actions require **Edit** or **Manage** access");
    expect(work).toContain("Use as new message");
    expect(work).toContain("Start new conversation from this message");
    expect(automation).toContain("no longer offers `add_keyword` for new steps");
  });

  test("keeps recent Mail navigation and mailing-list actions aligned", () => {
    const start = mailHelp.getMarkdown("mail-start");
    const admin = mailHelp.getMarkdown("mail-admin");
    const automation = mailHelp.getMarkdown("mail-automation");
    const work = mailHelp.getMarkdown("mail-work");

    expect(start).toContain("**Mailbox tools** for synchronization, health, automations");
    expect(start).not.toContain("- **Automations** for");
    expect(admin).toContain("Open **Mailbox tools → Automations**");
    expect(automation).toContain("Open **Mailbox tools → Automations**");
    expect(work).not.toContain("List help");
    expect(work).not.toContain("advertised help");
    expect(work).toContain("**List archive** opens the archive advertised by the list");
  });

  test("documents every incoming-automation schema term and structural limit in Help and the CLI skill", () => {
    const references = [
      ["Help", mailHelp.getMarkdown("mail-automation")],
      ["CLI", cliAutomationReference],
    ] as const;
    const schemaTerms = [...new Set(manifestTerms(z.toJSONSchema(createIncomingAutomationSchema)))];
    const limitTerms = [
      "1–120 characters",
      "1–8",
      "1–320",
      "1–253",
      "1–1,000",
      "1–100",
      "1–4,000",
      "200–10,000",
      "2–10",
      "1–80",
      "1–500",
      "1–50,000",
      "at most 12",
      "1–20",
      "at most 40 steps",
      "at most 4 branch levels",
      "at most 10 AI calls",
    ];

    for (const [label, reference] of references) {
      for (const term of [...schemaTerms, ...limitTerms]) {
        expect(reference, `${label} reference missing incoming-automation contract term ${term}`).toContain(term);
      }
    }
  });

  test("keeps the working-model automation examples accepted by the incoming automation contract", async () => {
    for (const file of ["../cli-references/index.md", "../../../../docs-site/apps-content/en/mail.md"]) {
      const markdown = await Bun.file(new URL(file, import.meta.url)).text();
      const examples = [...markdown.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1]!);
      expect(examples.length).toBeGreaterThanOrEqual(1);
      for (const source of examples) {
        expect(createIncomingAutomationSchema.safeParse(Bun.YAML.parse(source)).success, source).toBe(true);
      }
    }
  });

  test("keeps every documented workflow example valid for the Mail vocabulary", async () => {
    const markdown = [mailHelp.getMarkdown("mail-automation"), mailHelp.getMarkdown("mail-workflows")].join("\n");
    const examples = [...markdown.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1]!);
    const catalog = workflowCatalog();

    expect(examples.length).toBeGreaterThanOrEqual(7);
    for (const source of examples) {
      const compiled = await compileWorkflow(source, mailWorkflows);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) continue;
      expect((await bindMailWorkflow(compiled.ir, catalog)).ok).toBe(true);
    }
  });

  test("documents the complete Mail workflow manifest and language in Help and the CLI skill", () => {
    const references = [
      ["Help", mailHelp.getMarkdown("mail-workflows")],
      ["CLI", cliAutomationReference],
    ] as const;
    const manifest = mailWorkflows.manifest;
    const schemaTerms = [
      ...manifest.inputs.flatMap((input) => manifestTerms(input.config)),
      ...manifest.triggers.flatMap((trigger) => manifestTerms(trigger.config)),
      ...manifest.actions.flatMap((action) => manifestTerms(action.config)),
    ];
    const languageTerms = [
      "equals",
      "notEquals",
      "includes",
      "textEquals",
      "contains",
      "startsWith",
      "endsWith",
      "exists",
      "all",
      "any",
      "not",
      "now()",
    ];
    const budgetTerms = [
      "maxTargets",
      "maxMoves",
      "maxCopies",
      "maxSends",
      "maxDrafts",
      "maxFlagChanges",
      "maxNotifications",
      "maxKeywordChanges",
      "maxCollaborationChanges",
      "maxAiCalls",
    ];

    for (const [label, reference] of references) {
      for (const term of [
        ...manifest.inputs.map((input) => input.kind),
        ...manifest.triggers.map((trigger) => trigger.kind),
        ...manifest.actions.map((action) => action.kind),
        ...new Set(schemaTerms),
        ...languageTerms,
        ...budgetTerms,
      ]) {
        expect(reference, `${label} reference missing workflow term ${term}`).toContain(term);
      }
      for (const limit of Object.values(manifest.limits ?? {})) {
        expect(reference, `${label} reference missing workflow limit ${limit}`).toContain(limit.toLocaleString("en-US"));
      }
    }
  });

  test("keeps every CLI automation and workflow example accepted by the public contracts", async () => {
    const examples = [...cliAutomationReference.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1]!.trim());
    expect(examples.length).toBeGreaterThanOrEqual(6);

    expect(createAutomaticReplyConfigurationSchema.safeParse(Bun.YAML.parse(examples[0]!)).success).toBe(true);
    expect(createIncomingAutomationSchema.safeParse(Bun.YAML.parse(examples[1]!)).success).toBe(true);

    const catalog = workflowCatalog();
    for (const source of examples.slice(2)) {
      const compiled = await compileWorkflow(source, mailWorkflows);
      expect(compiled.ok, source).toBe(true);
      if (!compiled.ok) continue;
      expect((await bindMailWorkflow(compiled.ir, catalog)).ok, source).toBe(true);
    }
  });

  test("keeps the complete native Mail CLI registration and examples documented", async () => {
    const reference = cliMailReferences.join("\n");
    const commands = await registeredMailCliCommands();
    expect(commands.size).toBeGreaterThanOrEqual(200);
    expect(commands.has("sender mark-read")).toBe(false);

    for (const command of commands.keys()) {
      expect(reference, `CLI reference missing registered command ${command}`).toContain(command);
    }

    const globalFlags = new Set(["--json", "--jsonl", "--profile", "--server", "--token", "--quiet", "--debug"]);
    const examples = [...reference.matchAll(/```bash\n([\s\S]*?)```/g)]
      .flatMap((match) => match[1]!.replace(/\\\n\s*/g, " ").split("\n"))
      .map((line) => line.trim())
      .filter((line) => line.startsWith("cld "));

    for (const example of examples) {
      const tokens = [...example.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((match) => match[0]);
      const mailIndex = tokens.indexOf("mail");
      if (mailIndex < 1 || tokens.slice(1, mailIndex).some((token) => !token.startsWith("--"))) continue;
      const tail = tokens.slice(mailIndex + 1);
      const command = tail.map((_, index) => tail.slice(0, index + 1).join(" ")).findLast((candidate) => commands.has(candidate));
      expect(command, `CLI example uses an unregistered Mail command: ${example}`).toBeDefined();
      if (!command) continue;
      const help = commands.get(command)!;
      for (const flag of tokens.filter((token) => token.startsWith("--")).map((token) => token.split("=")[0]!)) {
        if (!globalFlags.has(flag)) expect(help, `CLI example uses undocumented flag ${flag}: ${example}`).toContain(flag);
      }
    }

    const jsonExamples = [...reference.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]!);
    expect(jsonExamples.length).toBeGreaterThanOrEqual(2);
    for (const example of jsonExamples) expect(() => JSON.parse(example)).not.toThrow();

    expect(reference).toContain("The Mail UI calls the standard `\\Flagged` state **Flag**");
    expect(commands.get("message star")).toContain("Add the standard Flag");
    expect(commands.get("message unstar")).toContain("Remove the standard Flag");
    expect(commands.get("flag")).toContain("Flag conversations");
    expect(commands.get("unflag")).toContain("Remove the flag from conversations");
  });
});
