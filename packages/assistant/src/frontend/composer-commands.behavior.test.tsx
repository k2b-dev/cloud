import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import type { AiRecentResource, AiSkillSummary } from "@k2b/cloud/ai";
import type { AiComposerAttachment } from "@k2b/cloud/ai/ui";
import type { CloudResourcePickerItem, CloudResourcePickerOptions } from "@k2b/cloud/browser/resource-picker";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { defineCapabilities, UniversalSearchDataSchema, UniversalSearchInputSchema } from "@k2b/cloud/contracts";
import { ok } from "@k2b/stdlib";
import type { ChatMention } from "@k2b/ui";
import { batch, createMemo, createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import { z } from "zod";
import { createDomTestHarness } from "../../../ui/test/dom";

const picker = mock<(options?: CloudResourcePickerOptions) => Promise<CloudResourcePickerItem | undefined>>(async () => undefined);
mock.module("@k2b/cloud/browser/resource-picker", () => ({ openCloudResourcePicker: picker }));
const catalogTags = [
  { tag: "note", title: "Notizen", description: "Notizen suchen", aliases: ["notes", "markdown"] },
  { tag: "notebook", title: "Notizbücher", description: "Notizbücher suchen", aliases: ["notebooks"] },
];
const catalog = {
  protocolVersion: 2,
  apps: [
    {
      appId: "notebooks",
      appName: "Notebooks",
      appIcon: "ti ti-notebook",
      appDescription: "Notes",
      // The manifest Notebooks would register, with its search tags.
      manifest: compileCapabilityManifest(
        "notebooks",
        defineCapabilities({
          protocolVersion: 2,
          // An app needs a resource reader for its tags to reach the composer.
          types: { note: { title: "Note", description: "One note.", reader: "read" } },
          queries: {
            read: {
              title: "Read a note",
              description: "Read one note.",
              input: z.object({ id: z.string().describe("Note id.") }).strict(),
              data: z.object({ title: z.string().describe("Note title.") }).strict(),
              openWorld: false,
              run: async () => ok({ data: { title: "Q3 plan" } }),
            },
            search: {
              title: "Search notes",
              description: "Find notes and notebooks.",
              input: UniversalSearchInputSchema,
              data: UniversalSearchDataSchema,
              openWorld: false,
              universalSearch: { tags: catalogTags },
              run: async () => ok({ data: [] }),
            },
          },
        }),
      ),
    },
  ],
  page: { hasMore: false },
};
const chosenNote: CloudResourcePickerItem = {
  appId: "notebooks",
  appName: "Notebooks",
  appIcon: "ti ti-notebook",
  readable: true,
  ref: { type: "notebooks.note", id: "Q3note" },
  title: "Q3 plan",
  href: "/notebooks/Q3note",
};

const fixedNow = "2026-10-10T12:00:00.000Z";
beforeEach(() => setSystemTime(new Date(fixedNow)));
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  setSystemTime();
  picker.mockReset();
  (await import("./composer-commands")).resetAssistantRecentResources();
});
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const settled = async () => {
  await Bun.sleep(160);
  await flush();
};
const skills: AiSkillSummary[] = Array.from({ length: 6 }, (_, i) => ({
  id: `skill-${i}`,
  shortId: `Skill${i}`,
  name: `Skill ${i}`,
  description: `Description ${i}`,
  permission: "read",
  enabled: true,
  revision: 1,
  source: i === 5 ? { appId: "assistant", appName: "Assistant" } : null,
  manualOnly: false,
  referenceCount: 0,
  createdAt: fixedNow,
  updatedAt: fixedNow,
}));

// Emulate native popovers in Happy DOM, including their close toggle.
const installPopoverStub = () => {
  const opened = new WeakSet<HTMLElement>();
  const prototype = HTMLElement.prototype;
  const matches = prototype.matches;
  Object.defineProperty(prototype, "matches", {
    configurable: true,
    writable: true,
    value(this: HTMLElement, selector: string): boolean {
      return selector === ":popover-open" ? opened.has(this) : matches.call(this, selector);
    },
  });
  prototype.showPopover = function () {
    if (opened.has(this)) return;
    opened.add(this);
    this.dispatchEvent(Object.assign(new Event("toggle"), { newState: "open" }));
  };
  prototype.hidePopover = function () {
    if (opened.delete(this)) this.dispatchEvent(Object.assign(new Event("toggle"), { newState: "closed" }));
  };
};

const mount = async (
  options: {
    add?: boolean;
    host?: ReturnType<typeof createDomTestHarness>;
    value?: string;
    locale?: string;
    attachments?: AiComposerAttachment[];
    mentions?: ChatMention[];
    choose?: () => Promise<readonly File[]>;
    catalogFail?: () => boolean;
    /** The catalog answers only once this settles. */
    catalogGate?: Promise<void>;
    empty?: boolean;
    skills?: AiSkillSummary[];
    skillsFail?: () => boolean;
    post?: () => Promise<Response>;
    track?: <T>(picking: Promise<T>) => Promise<T>;
    /** Checked recent references the server answers with; none by default. */
    recent?: AiRecentResource[];
    recentFail?: () => boolean;
    /** The recent references answer only once this settles. */
    recentGate?: () => Promise<void>;
    /** More parts that arrive without a new search, such as an upload finishing. */
    extraParts?: () => number;
  } = {},
) => {
  const dom = options.host ? { ...options.host, root: options.host.document.createElement("div") } : createDomTestHarness();
  if (options.host) {
    dom.document.body.append(dom.root);
    cleanups.push(() => dom.root.remove());
  } else cleanups.push(dom.cleanup);
  const locale = options.locale ?? "de";
  dom.document.documentElement.lang = locale;
  if (!options.host) installPopoverStub();
  delegateEvents(["click", "input", "keydown", "keyup"]);
  const { Chat } = await import("@k2b/ui");
  const { aiChatAttachments } = await import("@k2b/cloud/ai/ui");
  const {
    assistantBuiltInCommands,
    assistantCommandScopes,
    assistantCommandSections,
    assistantComposerCommands,
    assistantDraftRefs,
    assistantExcludedRefs,
    assistantInsertCommands,
    assistantRecentCommands,
    createAssistantCommandSession,
    createAssistantRecentResources,
  } = await import("./composer-commands");
  const { assistantCopyFor } = await import("./ui-copy");
  const { createCloudComposerCatalog } = await import("@k2b/cloud/browser/composer-insert");
  const requests: { url: URL; init?: RequestInit }[] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        requests.push({ url, init });
        if (url.pathname === "/api/capabilities/v1/catalog") {
          await options.catalogGate;
          return options.catalogFail?.() ? Response.json({ message: "Offline" }, { status: 500 }) : Response.json(catalog);
        }
        if (url.pathname === "/api/ai/resources/recent") {
          await options.recentGate?.();
          return options.recentFail?.()
            ? Response.json({ message: "Offline" }, { status: 500 })
            : Response.json({ resources: options.recent ?? [] });
        }
        if (url.pathname.endsWith("/run")) return options.post ? options.post() : Response.json({});
        if (url.pathname.startsWith("/api/ai/skills"))
          return options.skillsFail?.()
            ? Response.json({ message: "Skills offline" }, { status: 500 })
            : Response.json({ skills: options.skills ?? skills });
        if (url.pathname.endsWith("/files")) return Response.json({ files: [] });
        throw new Error(`Unexpected request: ${url}`);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  cleanups.push(() => fetchMock.mockRestore());
  const loader = createAssistantCommandSession();
  cleanups.push(() => loader.dispose());
  const [value, setValue] = createSignal(options.value ?? (options.add ? "Hello world" : "/"));
  const [selectedModel, setSelectedModel] = createSignal("alpha");
  const [state, setState] = createSignal<"idle" | "running">("idle");
  const [mentions, setMentions] = createSignal<readonly ChatMention[]>(options.mentions ?? []);
  const models = [
    { id: "alpha", label: "Alpha" },
    { id: "beta", label: "Beta" },
  ];
  const copy = assistantCopyFor(locale);
  const catalogTags = createCloudComposerCatalog();
  const insert = createMemo(() =>
    assistantInsertCommands({
      copy,
      locale,
      tags: catalogTags.tags(),
      partCount: () => (options.attachments ?? []).length + mentions().length,
      excludeRefs: () => assistantExcludedRefs(options.attachments ?? [], mentions()),
      fileSelectionDisabled: state() === "running",
      track: options.track,
    }),
  );
  // As the workspace does: the recent references load when the composer appears.
  const recent = createAssistantRecentResources();
  recent.ensure(locale);
  const draftRefs = () => assistantDraftRefs(options.attachments ?? [], mentions());
  const partCount = () => (options.attachments ?? []).length + mentions().length + (options.extraParts?.() ?? 0);
  const modelChanges: string[] = [];
  const chooseModel = (id: string) => {
    modelChanges.push(id);
    setSelectedModel(id);
  };
  let searches = 0;
  const dispose = render(
    () => (
      <Chat.Composer
        addOpensCommands={options.add}
        value={value()}
        state={state()}
        onValueChange={setValue}
        onSubmit={() => {
          throw new Error("Must not submit");
        }}
        mentions={mentions()}
        onMentionsChange={setMentions}
        models={models}
        selectedModelId={selectedModel()}
        onModelChange={chooseModel}
        commandSections={assistantCommandSections(copy)}
        commandScopes={[...assistantCommandScopes(copy, locale), ...insert().scopes]}
        commandFallback={insert().fallback}
        attachments={aiChatAttachments(options.attachments ?? [])}
        fileSelection={{ choose: options.choose ?? (async () => []), onSelect() {} }}
        commands={[
          ...assistantRecentCommands({ items: recent.items(), excludeRefs: draftRefs(), partCount, locale }),
          ...insert().commands,
          ...assistantBuiltInCommands({
            copy,
            projectComposer: false,
            running: state() === "running",
            recording: false,
            models,
            selectedModelId: selectedModel(),
            hasMessages: !options.empty,
            hasAssistantMessage: !options.empty,
            compact: async () => {},
            fork: async () => {},
            newChat: async () => {},
            searchChat: () => {
              searches++;
            },
          }),
        ]}
        searchCommands={(query, signal, search) => {
          // As the workspace does: typed text outside a scope waits for the opening's catalog answer.
          const recentAtOpening = recent.opened(search, locale);
          return Promise.all([
            assistantComposerCommands({
              recent: recent.items(),
              recentAtOpening,
              excludeRefs: draftRefs(),
              partCount,
              query,
              signal,
              session: search.opening,
              scope: search.scope,
              sessionLoader: loader,

              models,
              selectedModelId: selectedModel(),
              chooseModel,
              isRunning: () => state() === "running",
              locale,
              conversationId: "chat-1",
              projects: [],
              running: state() === "running",
              assignProject: async () => {},
            }),
            catalogTags.ready(query, search, locale),
          ]).then(([rows]) => rows);
        }}
      />
    ),
    dom.root,
  );
  cleanups.push(dispose);
  const input = dom.root.querySelector("textarea")!;
  const type = (text: string) =>
    batch(() => {
      input.value = text;
      input.setSelectionRange(text.length, text.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const key = (key: string) =>
    (dom.root.querySelector('input[role="combobox"]') ?? input).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  const rows = () => [...dom.root.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  const row = (label: string) => rows().find((row) => row.querySelector("strong")?.textContent === label)!;
  const mark = (label: string) => {
    const target = row(label);
    expect(target).toBeDefined();
    for (let i = 0; i < rows().length && target.getAttribute("aria-selected") !== "true"; i++) key("ArrowDown");
    expect(target.getAttribute("aria-selected")).toBe("true");
  };
  input.setSelectionRange(value().length, value().length);
  input.click();
  await settled();
  // The first catalog load can resolve a tag scope and start that scope’s search.
  await settled();
  return {
    ...dom,
    openPlus: (start = 5, end = start) => {
      input.focus();
      input.setSelectionRange(start, end);
      input.click();
      const plus = dom.root.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
      expect(plus).not.toBeNull();
      plus!.click();
      expect(dom.root.querySelector('input[role="combobox"]')).not.toBeNull();
    },
    input,
    type,
    key,
    rows,
    row,
    mark,
    value,
    mentions,
    modelChanges,
    setState,
    requests,
    searches: () => searches,
    status: () => dom.root.querySelector(".k2b-chat-composer__status")!.textContent,
    recentGets: () => requests.filter(({ url }) => url.pathname === "/api/ai/resources/recent"),
    headings: () => [...dom.root.querySelectorAll(".k2b-chat-composer__command-heading span")].map((el) => el.textContent),
    labels: () => rows().map((row) => row.querySelector("strong")?.textContent),
    posts: () => requests.filter(({ url }) => url.pathname.endsWith("/run")),
  };
};

test("empty chats hide compact, fork and search; searching shows the empty-chat reason", async () => {
  const h = await mount({ empty: true });
  for (const label of ["Chat kompaktieren", "Chat abzweigen", "In diesem Chat suchen"]) expect(h.row(label)).toBeUndefined();
  h.type("/suchen");
  await settled();
  expect(h.row("In diesem Chat suchen").querySelector("small")?.textContent).toBe("Der Chat ist noch leer");
  h.mark("In diesem Chat suchen");
  h.key("Enter");
  expect(h.searches()).toBe(0);
});

test.each(["Enter", "Tab"])("All Skills narrows with %s", async (key) => {
  const h = await mount();
  h.mark("Alle 6 Skills");
  h.key(key);
  await settled();
  expect(h.value()).toBe("/skill ");
  expect(h.row("Skill 5")).toBeDefined();
  expect(h.row("Alle 6 Skills")).toBeUndefined();
});

test("model action uses the composer's own menu; the model scope marks and chooses the current model", async () => {
  const h = await mount();
  h.mark("Modell wählen");
  h.key("Enter");
  await flush();
  const menu = h.root.querySelector<HTMLElement>(".k2b-select-chip__menu")!;
  expect(menu.matches(":popover-open")).toBe(true);
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await flush();
  expect(h.value()).toBe("/");
  h.type("/modell ");
  await settled();
  expect(h.rows().map((row) => row.querySelector("strong")?.textContent)).toEqual(["Alpha", "Beta"]);
  expect(h.row("Alpha").querySelector(".ti-check")).not.toBeNull();
  expect(h.row("Alpha").querySelector(".k2b-sr-only")?.textContent).toBe("gewählt");
  h.mark("Beta");
  h.key("Enter");
  await flush();
  expect(h.modelChanges).toEqual(["beta"]);
  expect(h.value()).toBe("");
  expect(h.status()).toBe("Modell für diesen Chat: Beta");
});

test("choosing a retained model after a run starts restores the token and shows the idle reason", async () => {
  const h = await mount({ value: "/model " });
  h.setState("running");
  h.row("Beta").click();
  await flush();
  expect(h.modelChanges).toEqual([]);
  expect(h.value()).toBe("/model ");
  expect(h.status()).toBe("Geht, sobald die Antwort fertig ist");
});

test("full Skill-list failure keeps other sections and retries Skills with Enter", async () => {
  let fail = true;
  const h = await mount({ skillsFail: () => fail });
  const skillGets = () => h.requests.filter(({ url }) => url.pathname === "/api/ai/skills" && !url.search);
  expect(skillGets()).toHaveLength(1);
  expect(h.row("Neue Routine")).toBeUndefined();
  expect(h.row("Modell wählen")).toBeDefined();
  expect(h.row("Aus Cloud einfügen")).toBeDefined();
  expect(h.row("Skills konnten nicht geladen werden").querySelector("small")?.textContent).toBe("Erneut versuchen");
  expect(h.row("Alle 6 Skills")).toBeUndefined();
  fail = false;
  h.mark("Skills konnten nicht geladen werden");
  h.key("Enter");
  await settled();
  expect(h.value()).toBe("/");
  expect(skillGets()).toHaveLength(2);
  expect(h.row("Skills konnten nicht geladen werden")).toBeUndefined();
  expect(h.row("Skill 0")).toBeDefined();
  expect(h.row("Alle 6 Skills")).toBeDefined();
  expect(h.row("Neue Routine")).toBeUndefined();
});

test("Insert leads the overview and tags appear only while typing", async () => {
  const h = await mount();
  expect(h.root.querySelector(".k2b-chat-composer__command-heading span")?.textContent).toBe("Einfügen");
  expect(
    h
      .rows()
      .slice(0, 2)
      .map((row) => row.querySelector("strong")?.textContent),
  ).toEqual(["Aus Cloud einfügen", "Datei anhängen"]);
  expect(h.row("Notizen")).toBeUndefined();
  expect(h.row("Notizbücher")).toBeUndefined();
  h.type("/notiz");
  await settled();
  expect(h.row("Notizen")).toBeDefined();
  expect(h.row("Notizbücher")).toBeDefined();
  expect(h.row("Notizen").closest('[role="group"]')?.textContent).toContain("Einfügen");
});

test("a narrowed picker inserts at the token place and one Undo restores it; cancelling preserves it", async () => {
  picker.mockResolvedValue(chosenNote);
  const h = await mount({ value: "Bitte /notiz q3" });
  expect(h.root.textContent).toContain("Notizen aus Notebooks");
  expect(h.row("„q3“ in Notizen suchen").querySelector("small")?.textContent).toBe("Aus Notebooks, mit Vorschau");
  h.key("Enter");
  await flush();
  expect(picker).toHaveBeenLastCalledWith(
    expect.objectContaining({
      scope: { appId: "notebooks", tag: "note", label: "Notizen · Notebooks", icon: "ti ti-notebook" },
      query: "q3",
      requireReader: true,
    }),
  );
  expect(h.value()).toBe("Bitte Q3 plan ");
  expect(h.mentions()).toEqual([
    { start: 6, end: 13, attachment: expect.objectContaining({ id: "resource:notebooks.note:Q3note", name: "Q3 plan" }) },
  ]);
  h.input.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
  expect(h.value()).toBe("Bitte /notiz q3");
  expect(h.mentions()).toEqual([]);
  picker.mockResolvedValue(undefined);
  h.type("/notiz q3");
  await settled();
  h.key("Enter");
  await flush();
  expect(h.value()).toBe("/notiz q3");
});

test("sixteen attachments disable Attach file and every resource insert row", async () => {
  const choose = mock(async () => []);
  const h = await mount({
    value: "/attach",
    choose,
    attachments: Array.from({ length: 16 }, (_, i) => ({
      kind: "resource",
      id: `resource:${i}`,
      name: `Note ${i}`,
      icon: "ti ti-note",
      ref: { type: "notebooks.note", id: `Note${i}` },
    })),
  });
  expect(h.row("Datei anhängen").querySelector("small")?.textContent).toBe("Eine Nachricht kann höchstens 16 Elemente enthalten.");
  h.key("Enter");
  await flush();
  expect(choose).not.toHaveBeenCalled();
  h.type("/notiz q3");
  await settled();
  expect(h.row("„q3“ in Notizen suchen").getAttribute("aria-disabled")).toBe("true");
  h.key("Enter");
  expect(picker).not.toHaveBeenCalled();
});

test("an unmatched query offers Cloud search and /app narrows to the Assistant's Studio tag", async () => {
  const h = await mount({ value: "/xylo", skills: [] });
  expect(h.root.textContent).toContain("Nichts gefunden für „xylo“");
  expect(h.row("„xylo“ in Cloud suchen")).toBeDefined();
  h.key("Enter");
  await flush();
  expect(picker).toHaveBeenLastCalledWith(expect.objectContaining({ scope: undefined, query: "xylo", requireReader: true }));
  h.type("/app q");
  await settled();
  expect(h.root.textContent).toContain("Studio-Apps aus Gustav");
});

test("a Studio app chosen through /app becomes the artifact reference the Assistant reads", async () => {
  picker.mockResolvedValueOnce({
    ref: { type: "assistant.app", id: "App1" },
    title: "Angebotsrechner",
    appId: "assistant",
    appName: "Assistent",
    appIcon: "ti ti-sparkles",
    readable: false,
    href: "/app/assistant/apps/App1",
  });
  const h = await mount({ value: "/app rech", skills: [] });
  h.key("Enter");
  await flush();
  // Studio apps have no Cloud reader, so this one picker lists only them, also after the chip is removed.
  expect(picker).toHaveBeenLastCalledWith(
    expect.objectContaining({
      scope: expect.objectContaining({ appId: "assistant", tag: "studio-app" }),
      query: "rech",
      resourceType: "assistant.app",
    }),
  );
  expect(picker.mock.calls.at(-1)?.[0]?.requireReader).toBeUndefined();
  await settled();
  expect(h.mentions()[0]?.attachment.data).toMatchObject({ kind: "resource", ref: { type: "assistant.artifact", id: "App1" } });
});

test("an open picker is tracked until it settles, so the workspace holds back saving a new chat meanwhile", async () => {
  let open = 0;
  let resolve!: (item: CloudResourcePickerItem | undefined) => void;
  picker.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const h = await mount({
    value: "/notiz q3",
    track: (picking) => {
      open++;
      return picking.finally(() => open--);
    },
  });
  h.key("Enter");
  await flush();
  expect(open).toBe(1);
  resolve(chosenNote);
  await settled();
  expect(open).toBe(0);
  expect(h.mentions()).toHaveLength(1);
});

test("attached and mentioned resources are excluded from the picker", async () => {
  const attachment: AiComposerAttachment = {
    kind: "resource",
    id: "resource:notebooks.note:old",
    name: "Old",
    icon: "ti ti-note",
    ref: { type: "notebooks.note", id: "old" },
  };
  const h = await mount({
    value: "Old /notiz q3",
    attachments: [{ ...attachment, id: "attached", ref: { type: "notebooks.note", id: "attached" } }],
    mentions: [{ start: 0, end: 3, attachment: { id: attachment.id, name: attachment.name, kind: "resource", data: attachment } }],
  });
  h.key("Enter");
  await flush();
  expect(picker.mock.calls.at(-1)?.[0]?.excludeRefs).toEqual([{ type: "notebooks.note", id: "attached" }, attachment.ref]);
});

test("a slow first catalog keeps the search pending, so a space after /notiz narrows once the tags arrive", async () => {
  let answer!: () => void;
  const gate = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const h = await mount({ locale: "de-LI", value: "/notiz", catalogGate: gate, skills: [] });
  await settled();
  // Not "nothing found" yet: the tags that could match have not arrived.
  expect(h.root.textContent).not.toContain("Nichts gefunden");
  h.type("/notiz ");
  answer();
  await settled();
  h.type("/notiz q3");
  await settled();
  expect(h.root.textContent).toContain("Notizen aus Notebooks");
  expect(h.row("„q3“ in Notizen suchen")).toBeDefined();
});

test("the Assistant's own scopes never wait for a catalog that does not answer", async () => {
  const h = await mount({ locale: "de-LU", value: "/modell ", catalogGate: new Promise<void>(() => {}), skills: [] });
  await settled();
  expect(h.row("Alpha")).toBeDefined();
  expect(h.row("Beta")).toBeDefined();
});

test("one successful catalog fetch serves two composers, keystrokes and later openings", async () => {
  const first = await mount({ locale: "de-AT" });
  const second = await mount({ locale: "de-AT", host: first });
  for (const h of [first, second]) {
    for (const value of ["/not", "/notiz", "/notiz q3", "plain", "/", "plain", "/notiz"]) {
      h.type(value);
      await settled();
    }
  }
  expect([...first.requests, ...second.requests].filter(({ url }) => url.pathname === "/api/capabilities/v1/catalog")).toHaveLength(1);
});

test("a failed catalog retries at the next opening and Studio narrowing works before success", async () => {
  let failed = true;
  const h = await mount({ locale: "de-CH", value: "/app q", catalogFail: () => failed });
  expect(h.root.textContent).toContain("Studio-Apps aus Gustav");
  h.type("/app qt");
  await settled();
  expect(h.requests.filter(({ url }) => url.pathname === "/api/capabilities/v1/catalog")).toHaveLength(1);
  failed = false;
  h.type("plain");
  h.type("/notiz");
  await settled();
  expect(h.row("Notizen")).toBeDefined();
  expect(h.requests.filter(({ url }) => url.pathname === "/api/capabilities/v1/catalog")).toHaveLength(2);
});

const recentItem = (type: string, id: string, title: string, extra: Partial<AiRecentResource> = {}): AiRecentResource => ({
  ref: { type, id },
  title,
  icon: "ti ti-file-text",
  kind: "Notiz",
  preview: "Vertrieb",
  appName: "Notebooks",
  count: 1,
  ...extra,
});
// In the server's recency order; the overview orders the four sent most often first.
const recentItems = [
  recentItem("notebooks.note", "N1", "Q3-Planung", { count: 3 }),
  recentItem("contacts.contact", "C1", "Mara Beispiel", {
    kind: "Kontakt",
    preview: "Müller GmbH",
    icon: "ti ti-address-book",
    appName: "Kontakte",
    count: 1,
  }),
  recentItem("core.ai.skill", "Skill1", "Skill 1", {
    kind: "Skill",
    preview: "Description 1",
    icon: "ti ti-sparkles",
    appName: "Assistent",
    count: 5,
  }),
  recentItem("notebooks.note", "N2", "Retro Q3", { count: 1 }),
  recentItem("notebooks.note", "N3", "Projekt Notizen", { preview: undefined, count: 2 }),
  recentItem("spaces.item", "T1", "Angebot prüfen", { kind: "Aufgabe oder Termin", preview: undefined, appName: "Spaces", count: 1 }),
];
// The list opens only after the references arrived, as it does when someone types "/" after the page loaded.
const mountWithRecent = async (options: Parameters<typeof mount>[0] = {}) => {
  const h = await mount({ value: "", recent: recentItems, ...options });
  h.type("/");
  // Skills answer after the debounce.
  await settled();
  await settled();
  return h;
};

test("the overview starts with Recent: the four sent most often, then most recently, each with kind and place", async () => {
  const h = await mountWithRecent();
  expect(h.headings()).toEqual(["Zuletzt", "Einfügen", "Skills", "Dieser Chat"]);
  expect(h.labels().slice(0, 6)).toEqual([
    "Skill 1",
    "Q3-Planung",
    "Projekt Notizen",
    "Mara Beispiel",
    "Aus Cloud einfügen",
    "Datei anhängen",
  ]);
  expect(h.row("Q3-Planung").querySelector("small")?.textContent).toBe("Notiz · Vertrieb");
  // Without a place, the app says where it lives.
  expect(h.row("Projekt Notizen").querySelector("small")?.textContent).toBe("Notiz · Notebooks");
  expect(h.row("Mara Beispiel").querySelector("small")?.textContent).toBe("Kontakt · Müller GmbH");
  // Each entry once: the recent Skill does not repeat under Skills, which still shows four.
  const labels = h.labels();
  expect(labels.slice(labels.indexOf("Datei anhängen") + 1, labels.indexOf("Modell wählen"))).toEqual([
    "Skill 0",
    "Skill 2",
    "Skill 3",
    "Skill 4",
    "Alle 6 Skills",
  ]);
  expect(h.recentGets()).toHaveLength(1);
});

test("choosing a recent row inserts its reference like any insert row", async () => {
  const h = await mountWithRecent();
  h.mark("Q3-Planung");
  h.key("Enter");
  await flush();
  expect(h.value()).toBe("Q3-Planung ");
  expect(h.mentions()).toEqual([
    {
      start: 0,
      end: 10,
      attachment: expect.objectContaining({ id: "resource:notebooks.note:N1", name: "Q3-Planung" }),
    },
  ]);
  expect(h.mentions()[0]?.attachment.data).toMatchObject({ kind: "resource", ref: { type: "notebooks.note", id: "N1" } });
});

test("a person without history sees no Recent; the list starts with Insert", async () => {
  const h = await mountWithRecent({ recent: [] });
  expect(h.headings()[0]).toBe("Einfügen");
  expect(h.labels()[0]).toBe("Aus Cloud einfügen");
});

test("references already in the draft and a full message are respected", async () => {
  const h = await mountWithRecent({
    mentions: [],
    attachments: [
      {
        kind: "resource",
        id: "resource:notebooks.note:N1",
        name: "Q3-Planung",
        icon: "ti ti-file-text",
        ref: { type: "notebooks.note", id: "N1" },
      },
    ],
  });
  expect(h.row("Q3-Planung")).toBeUndefined();
  expect(h.labels().slice(0, 4)).toEqual(["Skill 1", "Projekt Notizen", "Mara Beispiel", "Retro Q3"]);
  const full = await mountWithRecent({
    attachments: Array.from({ length: 16 }, (_, i) => ({
      kind: "resource" as const,
      id: `resource:${i}`,
      name: `Note ${i}`,
      icon: "ti ti-note",
      ref: { type: "notebooks.note", id: `Note${i}` },
    })),
  });
  expect(full.row("Skill 1").getAttribute("aria-disabled")).toBe("true");
  expect(full.row("Skill 1").querySelector("small")?.textContent).toBe("Eine Nachricht kann höchstens 16 Elemente enthalten.");
});

test("while typing, Recent is gone and matching recent references rank first inside Insert and Skills", async () => {
  const h = await mountWithRecent();
  h.type("/notiz");
  await settled();
  expect(h.headings()[0]).toBe("Einfügen");
  // A recent title word start comes before a tag's title start; other recent notes match by their kind.
  expect(h.labels().slice(0, 3)).toEqual(["Projekt Notizen", "Notizen", "Notizbücher"]);
  expect(h.labels()).toContain("Q3-Planung");
  h.type("/skill");
  await settled();
  expect(h.headings()).toContain("Skills");
  const skills = h.labels().filter((label) => label?.startsWith("Skill "));
  expect(skills.slice(0, 2)).toEqual(["Skill 1", "Skill 0"]);
  expect(h.row("Zuletzt")).toBeUndefined();
});

test("/notiz q3 lists the matching recent notes above the search row; other kinds stay out", async () => {
  const h = await mountWithRecent();
  h.type("/notiz q3");
  await settled();
  expect(h.headings()).toEqual(["Notizen aus Notebooks"]);
  expect(h.labels()).toEqual(["Q3-Planung", "Retro Q3", "„q3“ in Notizen suchen"]);
  h.type("/notiz ");
  await settled();
  expect(h.labels()).toEqual(["Q3-Planung", "Retro Q3", "Projekt Notizen", "Notizen durchsuchen"]);
});

test("/studio lists recent Studio apps, which the Assistant sends as assistant.artifact", async () => {
  const app = recentItem("assistant.artifact", "A1", "Umsatz Q3", { kind: "Studio-App", preview: undefined, appName: "Assistent" });
  const h = await mountWithRecent({ recent: [app, ...recentItems] });
  h.type("/studio q3");
  await settled();
  expect(h.labels()[0]).toBe("Umsatz Q3");
  expect(h.labels()).not.toContain("Q3-Planung");
});

test("a late answer never inserts Recent into the open list; the next opening shows it", async () => {
  let answer!: () => void;
  const gate = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const h = await mount({ value: "", recent: recentItems, recentGate: () => gate });
  h.type("/");
  await settled();
  await settled();
  expect(h.headings()[0]).toBe("Einfügen");
  const first = h.labels();
  answer();
  await settled();
  await settled();
  expect(h.headings()[0]).toBe("Einfügen");
  expect(h.labels()).toEqual(first);
  // Typing in the same opening changes rows as typing does; the overview of a new "/" has Recent.
  h.type("Bitte /");
  await settled();
  expect(h.headings()[0]).toBe("Zuletzt");
  expect(h.recentGets()).toHaveLength(1);
});

test("a failed load shows no Recent and no error row; only a new opening asks again", async () => {
  let failed = true;
  const h = await mount({ value: "", recent: recentItems, recentFail: () => failed });
  // The load when the composer appeared failed, so this first opening asks again.
  h.type("/");
  await settled();
  expect(h.headings()[0]).toBe("Einfügen");
  expect(h.root.textContent).not.toContain("Zuletzt");
  expect(h.recentGets()).toHaveLength(2);
  // Keystrokes in the same opening never ask.
  h.type("/s");
  await settled();
  h.type("/");
  await settled();
  expect(h.recentGets()).toHaveLength(2);
  failed = false;
  h.type("Bitte /");
  await settled();
  // Asked again at this opening, which opened before the answer: it stays without Recent.
  expect(h.recentGets()).toHaveLength(3);
  expect(h.headings()[0]).toBe("Einfügen");
  h.type("Bitte / /");
  await settled();
  expect(h.headings()[0]).toBe("Zuletzt");
  expect(h.recentGets()).toHaveLength(3);
});

test("an answer between opening and the first search keeps a recent Skill under Skills, so it is never missing", async () => {
  let answer!: () => void;
  const gate = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const h = await mount({ value: "", recent: recentItems, recentGate: () => gate });
  h.type("/");
  // The list opened without Recent; the answer arrives before the Skills search runs.
  answer();
  await flush();
  await settled();
  await settled();
  expect(h.headings()[0]).toBe("Einfügen");
  const labels = h.labels();
  expect(labels.slice(labels.indexOf("Datei anhängen") + 1, labels.indexOf("Modell wählen"))).toEqual([
    "Skill 0",
    "Skill 1",
    "Skill 2",
    "Skill 3",
    "Skill 4",
    "Alle 6 Skills",
  ]);
  // The next opening shows it once, under Recent.
  h.type("Bitte /");
  await settled();
  await settled();
  expect(h.headings()[0]).toBe("Zuletzt");
  expect(h.labels().filter((label) => label === "Skill 1")).toHaveLength(1);
});

test("an answer after the first search never adds a Skill row to the same open list", async () => {
  let answer!: () => void;
  const gate = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const h = await mount({ value: "", recent: recentItems, recentGate: () => gate });
  const skillRows = () => {
    const labels = h.labels();
    return labels.slice(labels.indexOf("Datei anhängen") + 1, labels.indexOf("Modell wählen"));
  };
  h.type("/");
  await settled();
  await settled();
  const first = skillRows();
  expect(first).toEqual(["Skill 0", "Skill 1", "Skill 2", "Skill 3", "Alle 6 Skills"]);
  answer();
  await settled();
  // Typing and deleting in the same opening runs the overview search again, now with the answer loaded.
  h.type("/a");
  await settled();
  h.type("/");
  await settled();
  await settled();
  expect(h.headings()[0]).toBe("Einfügen");
  expect(skillRows()).toEqual(first);
});

test("a recent search row checks the live part count when chosen, so a full message gets no reference", async () => {
  const [extra, setExtra] = createSignal(0);
  const h = await mountWithRecent({ extraParts: extra });
  h.type("/q3");
  await settled();
  expect(h.row("Q3-Planung").getAttribute("aria-disabled")).not.toBe("true");
  // Uploads finish while the list stays open; no search runs again.
  setExtra(16);
  h.mark("Q3-Planung");
  h.key("Enter");
  await flush();
  expect(h.mentions()).toEqual([]);
  expect(h.value()).toBe("/q3");
  expect(h.status()).toContain("Eine Nachricht kann höchstens 16 Elemente enthalten.");
});

test.each([false, true])("Plus starts with Insert after Recent when present (recent=%s)", async (recent) => {
  const h = await mount({ add: true, recent: recent ? recentItems : [] });
  h.openPlus();
  await settled();
  await settled();
  expect(h.headings()).toEqual([...(recent ? ["Zuletzt"] : []), "Einfügen", "Skills", "Dieser Chat"]);
  expect(h.labels().slice(recent ? 4 : 0, recent ? 6 : 2)).toEqual(["Aus Cloud einfügen", "Datei anhängen"]);
});

test("Plus Attach file uses fileSelection.choose and cancellation returns to the caret", async () => {
  const choose = mock(async () => []);
  const h = await mount({ add: true, choose });
  h.openPlus();
  h.mark("Datei anhängen");
  h.key("Enter");
  expect(choose).toHaveBeenCalledTimes(1);
  await flush();
  expect(h.value()).toBe("Hello world");
  expect(h.document.activeElement === h.input).toBe(true);
  expect(h.input.selectionStart).toBe(5);
});

test.each(["item", "app"])("Plus Cloud picker inserts the same model resource at the stored caret (icon=%s)", async (icon) => {
  const chosen = { ...chosenNote, icon: icon === "item" ? "ti ti-note" : undefined, appIcon: chosenNote.appIcon };
  picker.mockResolvedValueOnce(chosen);
  const h = await mount({ add: true });
  h.openPlus();
  h.mark("Aus Cloud einfügen");
  h.key("Enter");
  await flush();
  expect(picker).toHaveBeenCalledTimes(1);
  expect(picker).toHaveBeenLastCalledWith(expect.objectContaining({ requireReader: true }));
  expect(h.value()).toBe("Hello Q3 plan  world");
  expect(h.mentions()).toEqual([{ start: 6, end: 13, attachment: expect.objectContaining({ name: chosen.title, href: chosen.href }) }]);
  expect(h.document.activeElement === h.input).toBe(true);
  expect(h.input.selectionStart).toBe(14);
  const { aiChatAttachments, aiComposerSendInput } = await import("@k2b/cloud/ai/ui");
  const oldAttachment: AiComposerAttachment = {
    kind: "resource",
    id: `resource:${chosen.ref.type}:${chosen.ref.id}`,
    ref: chosen.ref,
    name: chosen.title,
    icon: chosen.icon ?? chosen.appIcon ?? "ti ti-cloud",
    href: chosen.href,
  };
  const oldDraft = aiComposerSendInput({ intent: "send", text: "Hello world", attachments: aiChatAttachments([oldAttachment]) });
  const newDraft = aiComposerSendInput({ intent: "send", text: h.value(), mentions: h.mentions(), attachments: [] });
  const oldPart = oldDraft.resources![0]!;
  const newPart = newDraft.draftContent!.find((part) => part.type === "resource")!;
  expect(oldPart).toEqual({ ref: chosen.ref, title: chosen.title, icon: oldAttachment.icon, href: chosen.href });
  expect(newPart).toEqual({ type: "resource", ...oldPart, inline: true });
  expect(newDraft.draftContent!.indexOf(newPart)).toBe(1);
  h.input.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }));
  expect(h.value()).toBe("Hello world");
  expect(h.mentions()).toEqual([]);
});

test("Plus Search this chat calls the existing searchChat action", async () => {
  const h = await mount({ add: true });
  h.openPlus();
  h.mark("In diesem Chat suchen");
  h.key("Enter");
  await flush();
  expect(h.searches()).toBe(1);
  expect(h.value()).toBe("Hello world");
});

test("Plus insert rows retain the attachment limit reason", async () => {
  const { AI_TURN_ATTACHMENT_MAX_ITEMS } = await import("@k2b/cloud/ai/ui");
  const choose = mock(async () => []);
  const h = await mount({
    add: true,
    choose,
    attachments: Array.from({ length: AI_TURN_ATTACHMENT_MAX_ITEMS }, (_, i) => ({
      kind: "resource",
      id: `resource:${i}`,
      name: `Note ${i}`,
      icon: "ti ti-note",
      ref: { type: "notebooks.note", id: `Note${i}` },
    })),
  });
  h.openPlus();
  for (const label of ["Aus Cloud einfügen", "Datei anhängen"]) {
    expect(h.row(label).getAttribute("aria-disabled")).toBe("true");
    expect(h.row(label).querySelector("small")?.textContent).toBe(
      `Eine Nachricht kann höchstens ${AI_TURN_ATTACHMENT_MAX_ITEMS} Elemente enthalten.`,
    );
    h.mark(label);
    h.key("Enter");
  }
  expect(choose).not.toHaveBeenCalled();
  expect(picker).not.toHaveBeenCalled();
});

test("Plus Attach file retains the running-answer reason", async () => {
  const choose = mock(async () => []);
  const h = await mount({ add: true, choose });
  h.setState("running");
  h.openPlus();
  expect(h.row("Datei anhängen").getAttribute("aria-disabled")).toBe("true");
  expect(h.row("Datei anhängen").querySelector("small")?.textContent).toBe("Geht, sobald die Antwort fertig ist");
  h.mark("Datei anhängen");
  h.key("Enter");
  expect(choose).not.toHaveBeenCalled();
});
