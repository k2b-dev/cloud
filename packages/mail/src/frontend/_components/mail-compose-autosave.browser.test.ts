import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../../ui/test/browser";
import { type DraftEditableContent, type DraftRecoveryCopy, draftEditableContentInputSchema, type MailDraft } from "../../contracts";
import type {} from "./MailComposerEditor.browser-harness";

const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./MailComposerEditor.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-composer-editor-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Composer editor harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  // The production stylesheets compile through Cloud's Tailwind plugin.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const harness = await buildHarness();
const css =
  "@layer properties, theme, base, components, utilities;" +
  (await buildCss(resolve(import.meta.dir, "../../styles/app.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../../../../styles.css")));
const now = "2026-10-11T10:00:00.000Z";
const initial = (): MailDraft => ({
  id: "Draft1",
  mailboxId: "Box001",
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  senderIdentityId: "Send01",
  signatureTemplateId: null,
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  body: "",
  format: "markdown",
  priority: "normal",
  requestDeliveryReceipt: false,
  requestReadReceipt: false,
  attachments: [],
  createdBy: { kind: "user", userId: "Usr001" },
  lastEditedBy: { kind: "user", userId: "Usr001" },
  lastEditedByDisplayName: "Ada",
  recoveryCopyCount: 0,
  revision: 1,
  editMode: "lock",
  generation: "1",
  state: "draft",
  deliveryClass: "normal",
  createdAt: now,
  updatedAt: now,
});
let stored = initial();
let active = 0,
  maximum = 0,
  conflicts = 0,
  loseAnswer = false;
let lease: { token: string; editorId: string } | null = null;
let firstWrite: Promise<void> | null = null;
let writes: Array<{ expectedRevision: number; draft: DraftEditableContent }> = [];
let copies: MailDraft[] = [];
let recoveryCopies: DraftRecoveryCopy[] = [];
const leaseAnswer = () => ({
  token: lease?.token,
  holder: { kind: "user", id: "Usr001", displayName: "Ada", avatarHash: null },
  acquiredAt: now,
  expiresAt: "2026-10-11T11:00:00.000Z",
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript" } });
    if (path === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
    if (path.endsWith("/recipient-suggestions")) return Response.json({ items: [] });
    if (path.endsWith("/compose-preview")) return Response.json({ html: "<p>Preview</p>", text: "Preview", formattingWarnings: [] });
    if (path.endsWith("/lease")) {
      if (request.method === "POST") {
        const input = (await request.json()) as { editorId: string; takeover: boolean };
        if (lease && lease.editorId !== input.editorId && !input.takeover)
          return Response.json({ code: "DRAFT_LEASE_HELD" }, { status: 409 });
        lease ??= { token: crypto.randomUUID(), editorId: input.editorId };
        if (input.takeover) lease = { token: crypto.randomUUID(), editorId: input.editorId };
        return Response.json(leaseAnswer());
      }
      if (request.method === "DELETE") {
        const input = (await request.json()) as { token: string };
        if (input.token === lease?.token) lease = null;
        return Response.json({});
      }
      if (request.method === "PUT") {
        const input = (await request.json()) as { token: string };
        return input.token === lease?.token
          ? Response.json(leaseAnswer())
          : Response.json({ code: "DRAFT_LEASE_NOT_OWNED" }, { status: 409 });
      }
      return Response.json(lease ? leaseAnswer() : null);
    }
    if (path.endsWith("/draft-seeds/materialize")) {
      const input = (await request.json()) as { draft: DraftEditableContent };
      stored = { ...stored, ...input.draft };
      return Response.json(stored);
    }
    if (path.endsWith("/recovery-copies")) return Response.json(recoveryCopies);
    if (path.includes("/recovery-copies/") && path.endsWith("/restore")) {
      const input = (await request.json()) as { expectedRevision: number; leaseToken: string };
      if (input.expectedRevision !== stored.revision || input.leaseToken !== lease?.token)
        return Response.json({ code: "CONFLICT" }, { status: 409 });
      const copy = recoveryCopies.find((copy) => path.includes(copy.id));
      if (!copy) return new Response(null, { status: 404 });
      recoveryCopies.push({
        id: crypto.randomUUID(),
        draftId: stored.id,
        baseRevision: stored.revision,
        content: draftEditableContentInputSchema.strip().parse(stored),
        createdBy: { kind: "user", userId: "Usr001" },
        createdAt: now,
        restoredAt: null,
        resultingRevision: null,
      });
      stored = {
        ...stored,
        ...copy.content,
        signatureTemplateId: copy.content.signatureTemplateId ?? null,
        revision: stored.revision + 1,
        recoveryCopyCount: stored.recoveryCopyCount,
      };
      copy.restoredAt = now;
      copy.resultingRevision = stored.revision;
      return Response.json(stored);
    }
    if (path.endsWith("/drafts") && request.method === "POST") {
      if (stored.conversationId)
        return Response.json({ code: "FORBIDDEN", message: "New conversations require mailbox-wide write access" }, { status: 403 });
      const content = draftEditableContentInputSchema.strip().parse(await request.json());
      const copy = { ...initial(), ...content, signatureTemplateId: content.signatureTemplateId ?? null, id: "Copy01" };
      copies.push(copy);
      return Response.json(copy);
    }
    if (path.endsWith("/drafts/Draft1")) {
      if (request.method === "GET") return Response.json(stored);
      if (request.method === "PUT") {
        const input = (await request.json()) as { expectedRevision: number; draft: DraftEditableContent };
        writes.push(input);
        active++;
        maximum = Math.max(active, maximum);
        try {
          if (firstWrite && writes.length === 1) await firstWrite;
          // Autosaves must stay serialized even when an answer takes longer than the save interval.
          await Bun.sleep(850);
          const same = Object.entries(input.draft).every(
            ([key, value]) => JSON.stringify(stored[key as keyof MailDraft]) === JSON.stringify(value),
          );
          if ((!same && input.expectedRevision !== stored.revision) || input.expectedRevision > stored.revision) {
            conflicts++;
            recoveryCopies.push({
              id: crypto.randomUUID(),
              draftId: stored.id,
              baseRevision: input.expectedRevision,
              content: input.draft,
              createdBy: { kind: "user", userId: "Usr001" },
              createdAt: now,
              restoredAt: null,
              resultingRevision: null,
            });
            stored = { ...stored, recoveryCopyCount: stored.recoveryCopyCount + 1 };
            return Response.json(
              { code: "CONFLICT", message: "Der aktuelle Stand hat sich geändert. Lade die Daten neu und versuche es erneut." },
              { status: 409 },
            );
          }
          if (!same)
            stored = {
              ...stored,
              ...input.draft,
              signatureTemplateId: input.draft.signatureTemplateId ?? null,
              revision: stored.revision + 1,
            };
          if (loseAnswer) {
            loseAnswer = false;
            return Response.json({ code: "INTERNAL", message: "Gateway timeout" }, { status: 504 });
          }
          return Response.json(stored);
        } finally {
          active--;
        }
      }
    }
    if (path.startsWith("/api/"))
      return Response.json({ code: "NOT_FOUND", message: `Unexpected ${request.method} ${path}` }, { status: 404 });
    return new Response(
      '<!doctype html><html class="light"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>#root{position:fixed;inset:0;display:flex}</style></head><body class="k2b-ui"><div id="root"></div><script src="/harness.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});
const reset = () => {
  stored = initial();
  active = 0;
  maximum = 0;
  conflicts = 0;
  loseAnswer = false;
  lease = null;
  writes = [];
  copies = [];
  recoveryCopies = [];
  firstWrite = null;
};
const mount = async (page: Page, seed = false) => {
  // Pin Date only: the 60-second typing exercise uses real timers and frames.
  await page.addInitScript((fixed) => {
    const NativeDate = Date;
    window.Date = new Proxy(NativeDate, {
      construct: (target, args) => Reflect.construct(target, args.length ? args : [fixed]),
      apply: () => new NativeDate(fixed).toString(),
      get: (target, property, receiver) => (property === "now" ? () => fixed : Reflect.get(target, property, receiver)),
    });
  }, Date.parse(now));
  await page.goto(server.url.href);
  await page.evaluate(
    ({ draft, seed }) =>
      window.mountComposer({ locale: "en", intent: "new", signatureTemplateId: null, serverTransport: true, serverDraft: draft, seed }),
    { draft: stored, seed },
  );
  await page.getByRole("textbox", { name: "Message body", exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[aria-label="Subject"]')?.disabled);
};
const bodyInput = (page: Page) => page.getByRole("textbox", { name: "Message body", exact: true });
const until = async (condition: () => boolean) => {
  const deadline = performance.now() + 10_000;
  while (!condition() && performance.now() < deadline) await Bun.sleep(25);
  expect(condition()).toBe(true);
};
const waitSaved = async (_page: Page, body: string) => {
  await until(() => stored.body === body && active === 0);
};

test("fresh compose continuously types for 60 seconds while subject and recipients change", async () => {
  reset();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  const errors = pageErrors(page);
  try {
    await mount(page, true);
    await page.evaluate(() => {
      const messages: string[] = [];
      Object.assign(window, { observedSaveConflicts: messages });
      new MutationObserver(() => {
        if (/changed elsewhere|anderswo geändert|aktuelle Stand hat sich geändert/i.test(document.body.textContent ?? ""))
          messages.push(document.body.textContent ?? "");
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    let expected = "";
    // These are real keystrokes over 60 wall seconds, including HTTP answers crossing later edits.
    for (let second = 0; second < 60; second++) {
      const started = performance.now();
      const text = `Line ${second}. `;
      await bodyInput(page).pressSequentially(text, { delay: 15 });
      expected += text;
      await page.getByRole("textbox", { name: "Subject", exact: true }).fill(`Subject ${second}`);
      if (second % 10 === 0) {
        const recipients = page.getByRole("combobox", { name: "Recipients", exact: true });
        await recipients.fill(`person${second}@example.test`);
        await recipients.press("Enter");
      }
      await bodyInput(page).press("End");
      const remaining = 1000 - (performance.now() - started);
      if (remaining > 0) await Bun.sleep(remaining);
    }
    await waitSaved(page, expected);
    expect(stored.subject).toBe("Subject 59");
    expect(stored.to.map((item) => item.address)).toEqual([0, 10, 20, 30, 40, 50].map((index) => `person${index}@example.test`));
    expect(maximum).toBe(1);
    expect(conflicts).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, "observedSaveConflicts"))).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 85_000);

test("a committed save with a timeout replays exact input before later edits", async () => {
  reset();
  loseAnswer = true;
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await mount(page);
    await bodyInput(page).fill("Committed before timeout");
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await bodyInput(page).fill("Latest text after timeout");
    await page.getByRole("textbox", { name: "Subject", exact: true }).fill("Latest subject");
    await waitSaved(page, "Latest text after timeout");
    expect(writes.slice(0, 3).map((input) => [input.expectedRevision, input.draft.body])).toEqual([
      [1, "Committed before timeout"],
      [1, "Committed before timeout"],
      [2, "Latest text after timeout"],
    ]);
    expect(stored.subject).toBe("Latest subject");
    expect(conflicts).toBe(0);
  } finally {
    await context.close();
  }
}, 20_000);

test("two tabs retain both versions through conflict, reload and save as new", async () => {
  reset();
  const gate = Promise.withResolvers<void>();
  firstWrite = gate.promise;
  const context = await browser.newContext();
  const a = await context.newPage();
  const b = await context.newPage();
  const dialogs: string[] = [];
  a.on("dialog", async (dialog) => {
    dialogs.push(dialog.type());
    await dialog.accept();
  });
  try {
    await mount(a);
    await bodyInput(a).fill("Tab A input must survive");
    await until(() => writes.length === 1);
    lease = null; // A's lease expires offline; B is now the exclusive editor.
    await mount(b);
    await bodyInput(b).fill("Tab B saved version");
    // A's request is deliberately still in flight until B has committed.
    await until(() => stored.body === "Tab B saved version");
    gate.resolve();
    await a.getByRole("button", { name: "Save as new draft", exact: true }).waitFor();
    expect(await a.evaluate(() => window.composerEditorState().source)).toBe("Tab A input must survive");
    await a.screenshot({ path: "/tmp/mail-compose-conflict-desktop.png" });
    await a.setViewportSize({ width: 375, height: 740 });
    await a.screenshot({ path: "/tmp/mail-compose-conflict-phone.png" });
    await b.close();
    lease = null;
    await mount(a); // The tab's local journal must survive a reload with a newer server revision.
    expect(await a.evaluate(() => window.composerEditorState().source)).toBe("Tab A input must survive");
    const dialogsBeforeCopy = dialogs.length;
    await a.getByRole("button", { name: "Save as new draft", exact: true }).click();
    await until(() => copies.length === 1);
    await a.waitForURL(/\/compose\/Copy01\?/);
    expect(dialogs).toHaveLength(dialogsBeforeCopy);
    expect(stored.body).toBe("Tab B saved version");
    expect(copies[0]?.body).toBe("Tab A input must survive");
  } finally {
    gate.resolve();
    await context.close();
  }
}, 20_000);

test("a reply conflict recovers within its assigned conversation and keeps later typing", async () => {
  reset();
  stored = { ...stored, conversationId: "Conv01", sourceMessageId: "Source1", intent: "reply" };
  const gate = Promise.withResolvers<void>();
  firstWrite = gate.promise;
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await mount(page);
    await bodyInput(page).fill("Submitted reply text");
    await until(() => writes.length === 1);
    stored = { ...stored, body: "Peer reply text", revision: 2 };
    gate.resolve();
    await page.getByRole("button", { name: "Copy text", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "Save as new draft", exact: true }).count()).toBe(0);
    await bodyInput(page).fill("Later reply typing must survive restore");
    await page.getByRole("button", { name: "Recover changes", exact: true }).first().click();
    await page.getByRole("button", { name: "Restore copy", exact: true }).click();
    await until(() => Boolean(recoveryCopies[0]?.restoredAt));
    await page.waitForFunction(() => window.composerEditorState().source === "Submitted reply text");
    expect(stored).toMatchObject({ conversationId: "Conv01", sourceMessageId: "Source1", intent: "reply", body: "Submitted reply text" });
    expect(copies).toHaveLength(0);
    expect(recoveryCopies.some((copy) => !copy.restoredAt && copy.content.body === "Peer reply text")).toBe(true);
    expect(
      await page.evaluate(() => Object.values(localStorage).some((raw) => raw.includes("Later reply typing must survive restore"))),
    ).toBe(true);
    await bodyInput(page).fill("Reply typing after successful restore");
    await waitSaved(page, "Reply typing after successful restore");
    expect(stored.conversationId).toBe("Conv01");
    expect(await page.getByRole("button", { name: "Copy text", exact: true }).count()).toBe(0);
  } finally {
    gate.resolve();
    await context.close();
  }
}, 20_000);

test("a reply recovered from an older offline journal remains saveable without a server recovery copy", async () => {
  reset();
  stored = {
    ...stored,
    conversationId: "Conv01",
    sourceMessageId: "Source1",
    intent: "reply",
    body: "Other device saved version",
    revision: 2,
  };
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(server.url.href);
    await page.evaluate(
      ({ content }) =>
        localStorage.setItem("cloud:user:Usr001:mail:cloud:mail:draft:Box001:Draft1", JSON.stringify({ revision: 1, content })),
      { content: draftEditableContentInputSchema.strip().parse({ ...stored, body: "Offline reply input" }) },
    );
    await mount(page);
    await page.getByRole("button", { name: "Copy text", exact: true }).waitFor();
    expect(recoveryCopies).toHaveLength(0);
    expect(await page.evaluate(() => window.composerEditorState().source)).toBe("Offline reply input");
    await page.screenshot({ path: "/tmp/mail-compose-reply-conflict-desktop.png" });
    await page.setViewportSize({ width: 375, height: 740 });
    await page.screenshot({ path: "/tmp/mail-compose-reply-conflict-phone.png" });
    await page.getByRole("button", { name: "Recover changes", exact: true }).first().click();
    await page.getByRole("button", { name: "Restore copy", exact: true }).click();
    await waitSaved(page, "Offline reply input");
    expect(stored).toMatchObject({ conversationId: "Conv01", sourceMessageId: "Source1", intent: "reply" });
    expect(copies).toHaveLength(0);
    expect(await page.evaluate(() => Object.values(localStorage).some((raw) => raw.includes("Other device saved version")))).toBe(true);
    await bodyInput(page).fill("More reply typing after recovery");
    await waitSaved(page, "More reply typing after recovery");
    expect(await page.getByRole("button", { name: "Copy text", exact: true }).count()).toBe(0);
  } finally {
    await context.close();
  }
}, 20_000);
