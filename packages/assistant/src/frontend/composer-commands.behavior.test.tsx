import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import type { AiChatTaskView, AiSkillSummary } from "@k2b/cloud/ai";
import type { ChatMention } from "@k2b/ui";
import { batch, createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

const fixedNow = "2026-10-10T12:00:00.000Z";
beforeEach(() => setSystemTime(new Date(fixedNow)));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  setSystemTime();
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
    value?: string;
    empty?: boolean;
    skills?: AiSkillSummary[];
    tasks?: AiChatTaskView[];
    tasksFail?: () => boolean;
    skillsFail?: boolean;
    scheduledTaskSkills?: AiSkillSummary[];
    scheduledTaskSkillsFail?: () => boolean;
    post?: () => Promise<Response>;
  } = {},
) => {
  const dom = createDomTestHarness();
  cleanups.push(dom.cleanup);
  dom.document.documentElement.lang = "de";
  installPopoverStub();
  delegateEvents(["click", "input", "keydown", "keyup"]);
  const { Chat } = await import("@k2b/ui");
  const {
    assistantBuiltInCommands,
    assistantCommandScopes,
    assistantCommandSections,
    assistantComposerCommands,
    createAssistantCommandSession,
  } = await import("./composer-commands");
  const { assistantCopyFor } = await import("./ui-copy");
  const requests: { url: URL; init?: RequestInit }[] = [];
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        requests.push({ url, init });
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
          return options.skillsFail
            ? Response.json({ message: "Skills offline" }, { status: 500 })
            : Response.json({ skills: options.skills ?? skills });
        if (url.pathname.includes("artifacts"))
          return Response.json({
            items: [{ id: "app-1", kind: "app", title: "Studio app", description: "Example" }],
            page: 1,
            hasNext: false,
          });
        if (url.pathname.endsWith("/files")) return Response.json({ files: [] });
        throw new Error(`Unexpected request: ${url}`);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  cleanups.push(() => fetchMock.mockRestore());
  const loader = createAssistantCommandSession();
  cleanups.push(() => loader.dispose());
  const [value, setValue] = createSignal(options.value ?? "/");
  const [selectedModel, setSelectedModel] = createSignal("alpha");
  const [state, setState] = createSignal<"idle" | "running">("idle");
  const [mentions, setMentions] = createSignal<readonly ChatMention[]>([]);
  const models = [
    { id: "alpha", label: "Alpha" },
    { id: "beta", label: "Beta" },
  ];
  const copy = assistantCopyFor("de");
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
        commandScopes={assistantCommandScopes(copy, "de")}
        commands={assistantBuiltInCommands({
          copy,
          projectComposer: false,
          running: state() === "running",
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
        })}
        searchCommands={(query, signal, search) =>
          assistantComposerCommands({
            query,
            signal,
            session: search.opening,
            scope: search.scope,
            sessionLoader: loader,
            models,
            selectedModelId: selectedModel(),
            chooseModel,
            isRunning: () => state() === "running",
            locale: "de",
            conversationId: "chat-1",
            projects: [],
            running: state() === "running",
            assignProject: async () => {},
          })
        }
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
    "Skills",
    "Studio-Apps",
    "Dieser Chat",
    "Geplante Aufgaben",
  ]);
  expect(h.rows().map((row) => row.querySelector("strong")?.textContent)).toEqual([
    "Skill 0",
    "Skill 1",
    "Skill 2",
    "Skill 3",
    "Alle 6 Skills",
    "Studio app",
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

test.each([500, 409])("task HTTP %s restores the token and reports the localized reason", async (status) => {
  const h = await mount({ value: "/routine Bericht 6", post: async () => Response.json({ message: "Server unavailable." }, { status }) });
  h.mark("Bericht 6");
  h.key("Enter");
  await flush();
  expect(h.value()).toBe("/routine Bericht 6");
  expect(h.status()).toBe(
    `„Bericht 6“ ist nicht gestartet: ${status === 409 ? "sie läuft schon oder ist nicht mehr aktiv" : "Server unavailable"}. Dein Entwurf ist unverändert.`,
  );
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
    scheduledTaskSkills: [{ ...skills[5]!, shortId: "OtherSkill", source: { appId: "other", appName: "Other" } }, skills[5]!],
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

test("full Skill-list failure uses the composer's search error", async () => {
  const h = await mount({ skillsFail: true });
  expect(h.row("Neue geplante Aufgabe")).toBeUndefined();
  expect(h.root.querySelector('[role="listbox"] [role="status"]')).not.toBeNull();
});

test("a failed full Skill list does not prevent task rows or the scheduled Skill reference", async () => {
  const h = await mount({ value: "/routine ", skillsFail: true });
  expect(h.row("Bericht 6")).toBeDefined();
  expect(h.row("Geplante Aufgaben konnten nicht geladen werden")).toBeUndefined();
  h.mark("Neue geplante Aufgabe");
  h.key("Enter");
  await flush();
  expect(h.mentions()[0]?.attachment.data).toMatchObject({ kind: "resource", ref: { type: "core.ai.skill", id: "Skill5" } });
});
