import { afterEach, beforeEach, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import type { AiChatTaskView, AiSkillSummary } from "@k2b/cloud/ai";
import type { AiComposerAttachment } from "@k2b/cloud/ai/ui";
import type { CloudSearchTag } from "@k2b/cloud/browser/composer-insert";
import type { CloudResourcePickerItem, CloudResourcePickerOptions } from "@k2b/cloud/browser/resource-picker";
import { currentLibrary } from "../../../cloud/test/future-capability-manifest";
import type { ChatMention } from "@k2b/ui";
import { batch, createMemo, createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
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
      manifest: {
        ...currentLibrary.manifest,
        appId: "notebooks",
        queries: currentLibrary.manifest.queries.map((query) =>
          query.universalSearch ? { ...query, universalSearch: { tags: catalogTags } } : query,
        ),
      },
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
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  setSystemTime();
  picker.mockReset();
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
  name: i === 5 ? "scheduled-tasks" : `Skill ${i}`,
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
const tasks: AiChatTaskView[] = Array.from({ length: 7 }, (_, i) => ({
  id: `Task0${i}`,
  chatId: `Chat0${i}`,
  chatTitle: "Task chat",
  prompt: `Bericht ${i}: Read calendar`,
  grants: [],
  schedule: { kind: "cron", cron: "0 7 * * *" },
  timezone: "UTC",
  state: "active",
  lastError: null,
  createdAt: `2026-10-0${i + 1}T12:00:00.000Z`,
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
    host?: ReturnType<typeof createDomTestHarness>;
    value?: string;
    locale?: string;
    attachments?: AiComposerAttachment[];
    mentions?: ChatMention[];
    choose?: () => Promise<readonly File[]>;
    catalogFail?: () => boolean;
    empty?: boolean;
    skills?: AiSkillSummary[];
    tasks?: AiChatTaskView[];
    tasksFail?: () => boolean;
    skillsFail?: () => boolean;
    scheduledTaskSkills?: AiSkillSummary[];
    scheduledTaskSkillsFail?: () => boolean;
    post?: () => Promise<Response>;
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
    assistantExcludedRefs,
    assistantInsertCommands,
    createAssistantCommandSession,
    createAssistantTaskRunKeys,
  } = await import("./composer-commands");
  const { loadCloudComposerCatalog } = await import("@k2b/cloud/browser/composer-insert");
  const { assistantCopyFor } = await import("./ui-copy");
  const requests: { url: URL; init?: RequestInit }[] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        requests.push({ url, init });
        if (url.pathname === "/api/capabilities/v1/catalog")
          return options.catalogFail?.() ? Response.json({ message: "Offline" }, { status: 500 }) : Response.json(catalog);
        if (url.pathname.endsWith("/run")) return options.post ? options.post() : Response.json({});
        if (url.pathname === "/api/ai/tasks")
          return options.tasksFail?.()
            ? Response.json({ message: "Offline" }, { status: 500 })
            : Response.json((options.tasks ?? tasks).filter((task) => task.state === url.searchParams.get("state")));
        if (url.pathname.startsWith("/api/ai/skills") && url.searchParams.has("name")) {
          expect(url.searchParams.get("name")).toBe("scheduled-tasks");
          expect(url.searchParams.has("q")).toBe(false);
          return options.scheduledTaskSkillsFail?.()
            ? Response.json({ message: "Skill lookup offline" }, { status: 500 })
            : Response.json({
                skills: options.scheduledTaskSkills ?? (options.skills ?? skills).filter((skill) => skill.name === "scheduled-tasks"),
              });
        }
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
  let storedRunKeys: string | null = null;
  const runKeys = createAssistantTaskRunKeys({
    getItem: () => storedRunKeys,
    setItem: (_key, value) => {
      storedRunKeys = value;
    },
  });
  cleanups.push(() => loader.dispose());
  const [value, setValue] = createSignal(options.value ?? "/");
  const [selectedModel, setSelectedModel] = createSignal("alpha");
  const [state, setState] = createSignal<"idle" | "running">("idle");
  const [mentions, setMentions] = createSignal<readonly ChatMention[]>(options.mentions ?? []);
  const models = [
    { id: "alpha", label: "Alpha" },
    { id: "beta", label: "Beta" },
  ];
  const copy = assistantCopyFor(locale);
  const [tags, setTags] = createSignal<readonly CloudSearchTag[]>([]);
  let opening: number | undefined;
  const insert = createMemo(() =>
    assistantInsertCommands({
      copy,
      locale,
      tags: tags(),
      attachmentCount: (options.attachments ?? []).length,
      partCount: (options.attachments ?? []).length + mentions().length,
      excludeRefs: () => assistantExcludedRefs(options.attachments ?? [], mentions()),
      fileSelectionDisabled: state() === "running",
    }),
  );
  const modelChanges: string[] = [];
  const chooseModel = (id: string) => {
    modelChanges.push(id);
    setSelectedModel(id);
  };
  let searches = 0;
  const dispose = render(
    () => (
      <Chat.Composer
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
          if (opening !== search.opening) {
            opening = search.opening;
            void loadCloudComposerCatalog(locale).then(
              (value) => setTags(value.tags),
              () => {},
            );
          }
          return assistantComposerCommands({
            query,
            signal,
            session: search.opening,
            scope: search.scope,
            sessionLoader: loader,
            runKeys,
            models,
            selectedModelId: selectedModel(),
            chooseModel,
            isRunning: () => state() === "running",
            locale,
            conversationId: "chat-1",
            projects: [],
            running: state() === "running",
            assignProject: async () => {},
          });
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
  const key = (key: string) => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
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
    taskGets: () => requests.filter(({ url }) => url.pathname === "/api/ai/tasks"),
    posts: () => requests.filter(({ url }) => url.pathname.endsWith("/run")),
  };
};

test("overview groups and rows have the requested order and independent task bound", async () => {
  const h = await mount();
  expect([...h.root.querySelectorAll(".k2b-chat-composer__command-heading span")].map((el) => el.textContent)).toEqual([
    "Einfügen",
    "Skills",
    "Dieser Chat",
    "Geplante Aufgaben",
  ]);
  expect(h.rows().map((row) => row.querySelector("strong")?.textContent)).toEqual([
    "Aus Cloud einfügen",
    "Datei anhängen",
    "Skill 0",
    "Skill 1",
    "Skill 2",
    "Skill 3",
    "Alle 6 Skills",
    "Modell wählen",
    "Projekt zuordnen",
    "Chat kompaktieren",
    "Chat abzweigen",
    "In diesem Chat suchen",
    "Neuer Chat",
    "Neue geplante Aufgabe",
    "Bericht 6",
    "Bericht 5",
    "Bericht 4",
    "Bericht 3",
    "Bericht 2",
  ]);
  expect(h.row("Modell wählen").querySelector("small")?.textContent).toBe("Jetzt: Alpha");
  h.mark("In diesem Chat suchen");
  h.key("Enter");
  await flush();
  expect(h.searches()).toBe(1);
});

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
  expect(h.row("scheduled-tasks")).toBeDefined();
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

test("task running status appears only after the deferred server acceptance", async () => {
  let accept!: (response: Response) => void;
  const h = await mount({
    value: "/routine ",
    post: () =>
      new Promise((resolve) => {
        accept = resolve;
      }),
  });
  expect(h.rows()).toHaveLength(8);
  h.mark("Bericht 6");
  h.key("Enter");
  await flush();
  expect(h.status()).toBe("„Bericht 6“ wird gestartet …");
  expect(h.status()).not.toContain("läuft");
  expect(h.posts()).toHaveLength(1);
  expect(new Headers(h.posts()[0]?.init?.headers).get("Idempotency-Key")).toMatch(/^[a-f0-9]{32}$/);
  accept(Response.json({}));
  await flush();
  expect(h.status()).toBe("„Bericht 6“ läuft. Das Ergebnis kommt in den Chat der geplanten Aufgabe.");
  expect(h.value()).toBe("");
});

test.each(["completed", "failed", "running", "queued"] as const)(
  "a successful replay with state %s reports its outcome and settles the key",
  async (state) => {
    const { assistantCopyFor } = await import("./ui-copy");
    const copy = assistantCopyFor("de");
    let attempt = 0;
    const h = await mount({
      value: "/routine Bericht 6",
      post: async () => {
        if (attempt++ === 0) throw new TypeError("Response lost");
        return Response.json({ state });
      },
    });
    for (let i = 0; i < 3; i++) {
      if (i > 0) {
        h.type("");
        h.type("/routine Bericht 6");
        await settled();
      }
      h.mark("Bericht 6");
      h.key("Enter");
      await flush();
      if (i === 0) {
        expect(h.value()).toBe("/routine Bericht 6");
        expect(h.status()).toBe(
          copy.commandTaskRunUnconfirmed({ title: "Bericht 6", reason: copy.commandTaskOffline }) + " " + copy.draftUnchanged,
        );
      } else {
        expect(h.value()).toBe("");
        expect(h.status()).toBe(
          (state === "completed"
            ? copy.commandTaskAlreadyRan
            : state === "failed"
              ? copy.commandTaskAlreadyFailed
              : copy.commandTaskRunning)({ title: "Bericht 6" }),
        );
      }
    }
    const keys = h.posts().map(({ init }) => new Headers(init?.headers).get("Idempotency-Key"));
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  },
);

test.each([409, 404, 429, 403, 500, 408, "offline"] as const)(
  "task failure %s restores the token and reports the localized reason",
  async (status) => {
    const { assistantCopyFor } = await import("./ui-copy");
    const copy = assistantCopyFor("de");
    const rawMessage = "Raw upstream failure.";
    const h = await mount({
      value: "/routine Bericht 6",
      post: async () => {
        if (status === "offline") throw new TypeError(rawMessage);
        return Response.json({ message: rawMessage }, { status });
      },
    });
    h.mark("Bericht 6");
    h.key("Enter");
    await flush();
    expect(h.value()).toBe("/routine Bericht 6");
    const unconfirmed = status === 500 || status === "offline";
    expect(h.status()).toBe(
      (unconfirmed
        ? copy.commandTaskRunUnconfirmed({
            title: "Bericht 6",
            reason: status === "offline" ? copy.commandTaskOffline : copy.commandTaskNoAnswer,
          })
        : copy.commandTaskRunFailed({
            title: "Bericht 6",
            reason:
              status === 409
                ? copy.commandTaskAlreadyRunning
                : status === 404
                  ? copy.commandTaskGone
                  : status === 429
                    ? copy.commandTaskTooMany
                    : copy.commandTaskNotAccepted,
          })) +
        " " +
        copy.draftUnchanged,
    );
    expect(h.status()).not.toContain(rawMessage);
  },
);

test("after a lost answer, a rejected retry still says the start is unconfirmed", async () => {
  const { assistantCopyFor } = await import("./ui-copy");
  const copy = assistantCopyFor("de");
  const answers = ["offline", 429, 409] as const;
  let attempt = 0;
  const h = await mount({
    value: "/routine Bericht 6",
    post: async () => {
      const answer = answers[attempt++]!;
      if (answer === "offline") throw new TypeError("Response lost");
      return Response.json({ message: "Raw" }, { status: answer });
    },
  });
  for (const [index, answer] of answers.entries()) {
    if (index > 0) {
      // Choose the task again from a fresh `/`.
      h.type("");
      h.type("/routine Bericht 6");
      await settled();
    }
    h.mark("Bericht 6");
    h.key("Enter");
    await flush();
    expect(h.value()).toBe("/routine Bericht 6");
    const reason =
      answer === "offline" ? copy.commandTaskOffline : answer === 429 ? copy.commandTaskTooMany : copy.commandTaskAlreadyRunning;
    expect(h.status()).toBe(copy.commandTaskRunUnconfirmed({ title: "Bericht 6", reason }) + " " + copy.draftUnchanged);
  }
});

test.each(["paused", "needs_attention"] as const)("%s task explains its reason and sends no POST", async (state) => {
  const h = await mount({ value: "/routine ", tasks: [{ ...tasks[0]!, state }] });
  const reason =
    state === "paused" ? "Pausiert. Setze die geplante Aufgabe zuerst fort." : "Braucht deinen Eingriff, bevor sie laufen kann";
  expect(h.row("Bericht 0").querySelector("small")?.textContent).toBe(reason);
  h.mark("Bericht 0");
  h.key("Enter");
  await flush();
  expect(h.posts()).toHaveLength(0);
  expect(h.value()).toBe("/routine ");
});

test("new scheduled task inserts the Assistant Skill from the name lookup when absent from the full list", async () => {
  const h = await mount({
    skills: skills.slice(0, 5),
    scheduledTaskSkills: [skills[5]!],
  });
  expect(h.row("Alle 5 Skills")).toBeDefined();
  h.type("/routine neu");
  await settled();
  h.mark("Neue geplante Aufgabe");
  h.key("Enter");
  await flush();
  expect(h.mentions()).toHaveLength(1);
  expect(h.mentions()[0]?.attachment.data).toMatchObject({ kind: "resource", ref: { type: "core.ai.skill", id: "Skill5" } });
  expect(h.value()).toBe("scheduled-tasks ");
});

test.each(["disabled", "missing"])("%s scheduled-tasks Skill explains why insertion is unavailable", async (kind) => {
  const h = await mount({
    value: "/routine ",
    skills: kind === "missing" ? skills.slice(0, 5) : skills.map((skill) => ({ ...skill, enabled: skill.id !== "skill-5" })),
  });
  expect(h.row("Neue geplante Aufgabe").querySelector("small")?.textContent).toBe(
    kind === "missing" ? "Der Skill dafür ist für dich nicht verfügbar" : "Du hast den Skill dafür ausgeschaltet",
  );
  h.key("Enter");
  await flush();
  expect(h.mentions()).toHaveLength(0);
  expect(h.value()).toBe("/routine ");
});

test("tasks, full Skills and the named Skill load once per opening, independently of keystroke cancellation", async () => {
  const h = await mount();
  expect(h.taskGets()).toHaveLength(3);
  expect(h.taskGets().map(({ url }) => url.searchParams.get("state"))).toEqual(["active", "paused", "needs_attention"]);
  for (const text of ["/b", "/be", "/bericht"]) {
    h.type(text);
    await settled();
  }
  expect(h.taskGets()).toHaveLength(3);
  expect(h.requests.filter(({ url }) => url.pathname.startsWith("/api/ai/skills") && !url.search)).toHaveLength(1);
  expect(h.requests.filter(({ url }) => url.searchParams.get("name") === "scheduled-tasks")).toHaveLength(1);
  h.key("Escape");
  h.type("");
  h.type("/");
  await settled();
  expect(h.taskGets()).toHaveLength(6);
  expect(h.requests.filter(({ url }) => url.searchParams.get("name") === "scheduled-tasks")).toHaveLength(2);
});

test.each([
  ["/", "tasks"],
  ["/bericht", "tasks"],
  ["/routine bericht", "tasks"],
  ["/", "skill"],
  ["/routine bericht", "skill"],
])("failed discovery at %s (%s) offers a retry that reloads and preserves the token", async (value, failure) => {
  let fail = true;
  const h = await mount({
    value,
    tasksFail: () => failure === "tasks" && fail,
    scheduledTaskSkillsFail: () => failure === "skill" && fail,
  });
  if (!value.startsWith("/routine")) expect(h.row("Skill 0")).toBeDefined();
  expect(h.row("Geplante Aufgaben konnten nicht geladen werden").querySelector("small")?.textContent).toBe("Erneut versuchen");
  expect(h.row("Neue geplante Aufgabe")).toBeUndefined();
  fail = false;
  h.mark("Geplante Aufgaben konnten nicht geladen werden");
  h.key("Enter");
  await settled();
  expect(h.value()).toBe(value);
  expect(h.taskGets()).toHaveLength(6);
  expect(h.row("Bericht 6")).toBeDefined();
});

test("full Skill-list failure keeps other sections and retries Skills with Enter", async () => {
  let fail = true;
  const h = await mount({ skillsFail: () => fail });
  const skillGets = () => h.requests.filter(({ url }) => url.pathname === "/api/ai/skills" && !url.search);
  expect(skillGets()).toHaveLength(1);
  expect(h.row("Neue geplante Aufgabe")).toBeDefined();
  expect(h.row("Bericht 6")).toBeDefined();
  expect(h.row("Bericht 2")).toBeDefined();
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
  expect(h.row("Neue geplante Aufgabe")).toBeDefined();
  expect(h.row("Bericht 6")).toBeDefined();
});

test("a failed full Skill list does not prevent task rows or the scheduled Skill reference", async () => {
  const h = await mount({ value: "/routine ", skillsFail: () => true });
  expect(h.row("Bericht 6")).toBeDefined();
  expect(h.row("Geplante Aufgaben konnten nicht geladen werden")).toBeUndefined();
  h.mark("Neue geplante Aufgabe");
  h.key("Enter");
  await flush();
  expect(h.mentions()[0]?.attachment.data).toMatchObject({ kind: "resource", ref: { type: "core.ai.skill", id: "Skill5" } });
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
  const h = await mount({ value: "/xylo", skills: [], tasks: [] });
  expect(h.root.textContent).toContain("Nichts gefunden für „xylo“");
  expect(h.row("„xylo“ in Cloud suchen")).toBeDefined();
  h.key("Enter");
  await flush();
  expect(picker).toHaveBeenLastCalledWith(expect.objectContaining({ scope: undefined, query: "xylo", requireReader: true }));
  h.type("/app q");
  await settled();
  expect(h.root.textContent).toContain("Studio-Apps aus Assistent");
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
  const h = await mount({ value: "/app rech", skills: [], tasks: [] });
  h.key("Enter");
  await flush();
  // Studio apps have no Cloud reader, so this one picker lists them without one.
  expect(picker).toHaveBeenLastCalledWith(
    expect.objectContaining({
      scope: expect.objectContaining({ appId: "assistant", tag: "studio-app" }),
      query: "rech",
      requireReader: false,
    }),
  );
  await settled();
  expect(h.mentions()[0]?.attachment.data).toMatchObject({ kind: "resource", ref: { type: "assistant.artifact", id: "App1" } });
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
  expect(h.root.textContent).toContain("Studio-Apps aus Assistent");
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
