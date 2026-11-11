import { afterEach, expect, spyOn, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { type CodeVersionPreview, codeVersionOwnPageHref, codeVersionPageHref } from "./code-activation";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const codeId = "c_info01";
const versionId = "66666666-6666-4666-8666-666666666666";

const preview = (patch: Partial<CodeVersionPreview> = {}): CodeVersionPreview => ({
  codeId,
  title: "Code of info@",
  ownerKind: "resource",
  versionId,
  number: 5,
  running: 4,
  latest: 5,
  activated: null,
  allowed: { allowed: true },
  readiness: { state: "ready" },
  place: { title: "info@example.test", typeTitle: "mailbox", href: "/app/mail/m_info" },
  page: "/app/mail/m_info/code",
  ...patch,
});

const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

/** Mounts the card with Core's routes answered by `routes`; a missing route is an outage. */
type Answer = { status?: number; json?: unknown };
const mount = async (routes: Record<string, (body: unknown) => Answer | Promise<Answer>>) => {
  const dom = createDomTestHarness();
  const calls: Array<{ route: string; body: unknown }> = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const route = String(url).replace("/api/code/", "");
    const body = JSON.parse(String(init?.body ?? "null"));
    calls.push({ route, body });
    const answer = await routes[route]?.(body);
    if (!answer) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify(answer.json ?? {}), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch);
  const { default: Card } = await import("./AssistantCodeVersionCard");
  const activated: number[] = [];
  const dispose = render(
    () => <Card codeId={codeId} versionId={versionId} number={5} timeZone="UTC" onActivated={() => activated.push(1)} />,
    dom.root,
  );
  restore.push(() => {
    dispose();
    fetchSpy.mockRestore();
    dom.cleanup();
  });
  await tick();
  return { dom, calls, activated };
};
const button = (root: Element, name: string) =>
  [...root.querySelectorAll("button, a")].find((element) => element.textContent?.includes(name)) as HTMLElement | undefined;

test("version preview offers switching on without inspecting or granting target rights", async () => {
  const { dom, calls } = await mount({ "activation/preview": () => ({ json: { data: preview() } }) });
  const text = dom.root.textContent ?? "";
  expect(text).toContain("Version 5 of “Code of info@” is ready.");
  expect(text).toContain("service account");
  expect(text).not.toContain("Logistics");
  expect(text).not.toContain("you manage");
  expect(button(dom.root, "Switch on")).toBeDefined();
  expect(button(dom.root, "Difference")?.getAttribute("href")).toBe(`/app/mail/m_info/code?tab=versions&version=${versionId}`);
  expect(calls.map((call) => call.route)).toEqual(["activation/preview"]);
});

test("the card lists what the version calls where, as the Code page does, and marks what is new", async () => {
  const target = (id: string, own = false) => ({
    key: `mail.mailbox\u0000${id}`,
    ref: { type: "mail.mailbox", id },
    title: null,
    typeTitle: "Mailbox",
    icon: "ti ti-mail",
    own,
    href: null,
  });
  const targets = [
    { target: target("m_info", true), operations: [], isNew: false },
    { target: target("m_billing"), operations: ["mail.message.read", "mail.message.move"], isNew: true },
    { target: null, operations: ["spaces.task.create"], isNew: false },
  ];
  // Operations read by their titles, as the Code page names them; the registry does not name the Spaces one here.
  const operationLabels = {
    "mail.message.read": { title: "Read message", app: "Mail" },
    "mail.message.move": { title: "Move message", app: "Mail" },
  };
  const { dom } = await mount({ "activation/preview": () => ({ json: { data: preview({ targets, operationLabels }) } }) });
  const rows = [...dom.root.querySelectorAll(".assistant-code-version__target")].map((row) => row.textContent);
  expect(dom.root.textContent).toContain("What this version may do");
  expect(rows).toEqual([
    "at info@example.test itself",
    "Read message · MailMove message · Mailat Mailbox m_billingnew",
    "spaces.task.createwhere the Code picks it while running",
  ]);
  // The technical ID stays in the tooltip; an unnamed one shows as an ID.
  const operations = [...dom.root.querySelectorAll(".assistant-code-version__ops > span")];
  expect(operations.map((operation) => [operation.getAttribute("title"), operation.hasAttribute("data-id")])).toEqual([
    ["mail.message.read", false],
    ["mail.message.move", false],
    ["spaces.task.create", true],
  ]);

  // A place this person may not read is named like any target, by type and ID.
  restore.splice(0).forEach((undo) => undo());
  const hidden = await mount({ "activation/preview": () => ({ json: { data: preview({ targets, place: null }) } }) });
  expect(hidden.dom.root.querySelector(".assistant-code-version__target")?.textContent).toBe("at Mailbox m_info itself");

  restore.splice(0).forEach((undo) => undo());
  const none = await mount({ "activation/preview": () => ({ json: { data: preview({ targets: [] }) } }) });
  expect(none.dom.root.textContent).toContain("Calls no app.");
});

test("switching on runs Core's activation and the card becomes one line, the same after a reload", async () => {
  let on = false;
  const { dom, calls, activated } = await mount({
    "activation/preview": () => ({
      json: {
        data: on ? preview({ running: 5, activated: { at: "2026-10-31T14:20:00.000Z", byYou: true, byName: null } }) : preview(),
      },
    }),
    activate: () => {
      on = true;
      return { json: { data: { state: "active", failure: null } } };
    },
  });
  button(dom.root, "Switch on")!.click();
  await tick();
  await tick();
  const start = calls.find((call) => call.route === "activate")!;
  expect(start.body).toMatchObject({ codeId, versionId });
  expect(activated).toEqual([1]);
  expect(dom.root.textContent).toMatch(/Version 5 switched on · .* · by you/);
  expect(button(dom.root, "Switch on")).toBeUndefined();
});

test("a switched-on version links its page, its next run and its runs in the same paint as its line", async () => {
  const automation = (nextRunAt: string | null) => ({
    entrypoint: "morning",
    kind: "schedule",
    cron: "0 7 * * *",
    nextRunAt,
    lastRun: null,
    missingTargets: [],
  });
  const on = preview({
    running: 5,
    activated: { at: "2026-10-31T14:20:00.000Z", byYou: true, byName: null },
    automations: [
      { entrypoint: "morning", title: "Every morning" },
      { entrypoint: "GET /invoices/:id", route: { method: "GET", path: "/invoices/:id", public: false } },
      { entrypoint: "GET /", route: { method: "GET", path: "/", public: false } },
    ],
  });
  const { dom, calls } = await mount({
    "activation/preview": () => ({ json: { data: on } }),
    "/api/capabilities/v1/queries/core/code.automation.list": () => ({
      json: { data: { items: [automation("2026-11-11T07:00:00.000Z"), automation(null)], removedTargets: [] } },
    }),
  });
  const links = [...dom.root.querySelectorAll(".assistant-code-version__links a")].map((link) => [
    link.textContent,
    link.getAttribute("href"),
  ]);
  expect(links).toEqual([
    ["Open page", "/code/c_info01/"],
    [expect.stringMatching(/^Next run .*11.*07:00/), "/app/mail/m_info/code"],
    ["Runs", "/app/mail/m_info/code?tab=runs"],
  ]);
  expect(calls.map((call) => call.route)).toEqual(["activation/preview", "/api/capabilities/v1/queries/core/code.automation.list"]);

  // Without a declared Code page and without a schedule, the line stays alone.
  restore.splice(0).forEach((undo) => undo());
  const bare = await mount({
    "activation/preview": () => ({ json: { data: { ...on, page: null, automations: [] } } }),
    "/api/capabilities/v1/queries/core/code.automation.list": () => ({ json: { data: { items: [], removedTargets: [] } } }),
  });
  expect(bare.dom.root.querySelector(".assistant-code-version__links")).toBeNull();
});

test("a refusal says nothing changed and offers to try again with a new identity", async () => {
  const { dom, calls } = await mount({
    "activation/preview": () => ({ json: { data: preview() } }),
    activate: () => ({ json: { data: { state: "failed", failure: { reason: "Owner authority changed." } } } }),
  });
  button(dom.root, "Switch on")!.click();
  await tick();
  expect(dom.root.textContent).toContain("Owner authority changed. Nothing changed, version 4 keeps running.");
  button(dom.root, "Try again")!.click();
  await tick();
  const ids = calls.filter((call) => call.route === "activate").map((call) => (call.body as { activationId: string }).activationId);
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
});

test("a lost answer asks Core's status and never starts a second activation", async () => {
  const { dom, calls } = await mount({
    "activation/preview": () => ({ json: { data: preview() } }),
    "activation/read": () => ({ json: { data: { state: "active", failure: null } } }),
  });
  button(dom.root, "Switch on")!.click();
  await tick();
  await tick();
  expect(calls.filter((call) => call.route === "activate")).toHaveLength(1);
  expect(calls.filter((call) => call.route === "activation/read")).toHaveLength(1);
});

test("a phone sees why it cannot switch on; waiting for approval offers no switch", async () => {
  const phone = await mount({
    "activation/preview": () => ({ json: { data: preview({ allowed: { allowed: false, reason: "phone" } }) } }),
  });
  expect(phone.dom.root.textContent).toContain("not possible on a phone");
  expect(button(phone.dom.root, "Switch on")?.hasAttribute("disabled")).toBe(true);
  for (const undo of restore.splice(0)) undo();
  const pending = await mount({ "activation/preview": () => ({ json: { data: preview({ readiness: { state: "approval_pending" } }) } }) });
  expect(pending.dom.root.textContent).toContain("A Cloud administrator must approve this version first.");
  expect(button(pending.dom.root, "Switch on")).toBeUndefined();
});

test("an older version, no access and an outage each say so; the outage retries", async () => {
  const older = await mount({ "activation/preview": () => ({ json: { data: preview({ latest: 6 }) } }) });
  expect(older.dom.root.textContent).toContain("Version 5 was replaced by version 6.");
  for (const undo of restore.splice(0)) undo();
  const denied = await mount({ "activation/preview": () => ({ status: 403, json: {} }) });
  expect(denied.dom.root.textContent).toContain("You no longer have access to this Code.");
  for (const undo of restore.splice(0)) undo();
  let answers = 0;
  const down = await mount({
    "activation/preview": () => (answers++ === 0 ? { status: 503 } : { json: { data: preview() } }),
  });
  expect(down.dom.root.querySelector('[role="alert"]')?.textContent).toContain("Could not check this version.");
  button(down.dom.root, "Retry")!.click();
  await tick();
  expect(button(down.dom.root, "Switch on")).toBeDefined();
});

test("the Code page is the one the owner's app declares, or a personal Code's page in Gustav", () => {
  expect(codeVersionPageHref(preview())).toBe("/app/mail/m_info/code");
  expect(codeVersionPageHref(preview({ ownerKind: "person", place: null, page: null }))).toBe(`/app/assistant/code/${codeId}`);
  // Without a declared page there is no address, also when the place is readable; Code of a place never gets a personal page.
  expect(codeVersionPageHref(preview({ page: null }))).toBeNull();
  expect(codeVersionPageHref(preview({ page: undefined, place: null }))).toBeNull();
});

test("a page served for every method opens like a GET page; a page with a named segment does not", () => {
  const route = (method: string, path: string) => ({ entrypoint: `${method} ${path}`, route: { method, path, public: false } });
  expect(codeVersionOwnPageHref(preview({ automations: [route("ALL", "/")] }))).toBe(`/code/${codeId}/`);
  expect(codeVersionOwnPageHref(preview({ automations: [route("GET", "/item/:id"), route("POST", "/")] }))).toBeNull();
});

test("an activation whose person is hidden or gone is credited to nobody", async () => {
  const { dom } = await mount({
    "activation/preview": () => ({
      json: { data: preview({ running: 5, activated: { at: "2026-10-31T14:20:00.000Z", byYou: false, byName: null } }) },
    }),
  });
  expect(dom.root.textContent).toContain("Version 5 switched on");
  expect(dom.root.textContent).not.toContain("by you");
});

test("the chat version card names reviewed automations and falls back to their identifiers", async () => {
  const { dom } = await mount({
    "activation/preview": () => ({
      json: { data: preview({ automations: [{ entrypoint: "deliver", title: "Lieferungen eintragen" }, { entrypoint: "legacyJob" }] }) },
    }),
  });
  expect(dom.root.textContent).toContain("Lieferungen eintragen · legacyJob");
  expect(dom.root.textContent).not.toContain("deliver");
});

test("the card shows everything a version may do: pages and who opens them, events by place, internet, secrets and database", async () => {
  const place = {
    key: "spaces.space\u0000Spc001",
    ref: { type: "spaces.space", id: "Spc001" },
    title: null,
    typeTitle: "Space",
    icon: "ti ti-layout-board",
    own: false,
    href: null,
  };
  const automations = [
    { entrypoint: "route:GET:/", route: { method: "GET", path: "/", public: false } },
    { entrypoint: "route:GET:/status", title: "Status", route: { method: "GET", path: "/status", public: true } },
    { entrypoint: "event:spaces.item.due@1:place:0", event: { type: "spaces.item.due", title: "Item due", place } },
  ];
  const full = preview({
    ownerKind: "person",
    place: null,
    targets: [],
    automations,
    internet: ["https://api.example.test"],
    secrets: [{ name: "API_TOKEN", origin: "https://api.example.test" }],
    database: true,
  });
  const { dom } = await mount({ "activation/preview": () => ({ json: { data: full } }) });
  const rows = [...dom.root.querySelectorAll(".assistant-code-version__target")].map((row) => row.textContent);
  expect(rows).toEqual([
    "GET /All signed-in people (no guests) · runs with your rights",
    "StatusPublic · no sign-in",
    "Starts on “Item due”at Space Spc001",
    "https://api.example.teston the internet, sends API_TOKEN",
    "Reads and writesin its own database",
  ]);
  // An event is named by its title and place, never by its stable entrypoint.
  expect(dom.root.textContent).toContain("Item due · Space Spc001");
  expect(dom.root.textContent).not.toContain("event:spaces.item.due");
  expect(dom.root.textContent).not.toContain("Calls no app.");

  // Each kind alone is enough to say the version does something; a place's page runs with its service account, named after it.
  for (const patch of [
    { automations: [automations[0]!] },
    { automations: [automations[2]!] },
    { internet: ["https://api.example.test"] },
    { database: true },
  ]) {
    restore.splice(0).forEach((undo) => undo());
    const one = await mount({ "activation/preview": () => ({ json: { data: preview({ targets: [], ...patch }) } }) });
    expect(one.dom.root.textContent).not.toContain("Calls no app.");
    expect(one.dom.root.querySelectorAll(".assistant-code-version__target")).toHaveLength(1);
    if (patch.automations?.[0]?.route)
      expect(one.dom.root.textContent).toContain(
        "All signed-in people (no guests) · runs with the rights of the service account “Code of info@example.test”",
      );
  }
});

test("a step keeps the card as it is while it reloads: no skeleton, the switch stays busy until the new state", async () => {
  let on = false;
  let answerReload: (() => void) | null = null;
  const { dom } = await mount({
    "activation/preview": () =>
      on
        ? new Promise<Answer>((resolve) => {
            answerReload = () =>
              resolve({
                json: { data: preview({ running: 5, activated: { at: "2026-10-31T14:20:00.000Z", byYou: true, byName: null } }) },
              });
          })
        : { json: { data: preview() } },
    activate: () => {
      on = true;
      return { json: { data: { state: "active", failure: null } } };
    },
  });
  button(dom.root, "Switch on")!.click();
  await tick();
  // Core said yes and the card reads again: it shows what it showed, never the skeleton, and offers no second switch.
  expect(dom.root.querySelector('[data-state="loading"]')).toBeNull();
  expect(dom.root.querySelector('[data-state="ready"]')).not.toBeNull();
  expect(button(dom.root, "Switch on")?.hasAttribute("disabled")).toBe(true);
  answerReload!();
  await tick();
  expect(dom.root.querySelector('[data-state="on"]')).not.toBeNull();
});

test("progress and refusal appear in one fixed slot after the actions, so the switch never moves", async () => {
  const { dom } = await mount({
    "activation/preview": () => ({ json: { data: preview() } }),
    activate: () => ({ json: { data: { state: "failed", failure: { reason: "Owner authority changed." } } } }),
  });
  const actions = dom.root.querySelector(".assistant-code-version__actions")!;
  const children = () => [...actions.children].map((child) => child.className.split(" ")[0] || child.tagName);
  const before = children();
  // The slot is there before anything happens: a live region that already exists is announced reliably.
  expect(actions.querySelector('.assistant-code-version__status[role="status"]')?.textContent).toBe("");
  button(dom.root, "Switch on")!.click();
  await tick();
  expect(children()).toEqual(before);
  expect(actions.firstElementChild?.textContent).toContain("Try again");
  expect(actions.querySelector('.assistant-code-version__status [role="alert"]')?.textContent).toContain("Owner authority changed.");
});

test("focus follows the switch to its result: the switched-on line, or the switch again after a refusal", async () => {
  let on = false;
  const switched = await mount({
    "activation/preview": () => ({
      json: {
        data: on ? preview({ running: 5, activated: { at: "2026-10-31T14:20:00.000Z", byYou: true, byName: null } }) : preview(),
      },
    }),
    activate: () => {
      on = true;
      return { json: { data: { state: "active", failure: null } } };
    },
  });
  const press = (root: Element, name: string) => {
    const control = button(root, name)!;
    control.focus();
    control.click();
  };
  press(switched.dom.root, "Switch on");
  await tick();
  await tick();
  const line = switched.dom.root.querySelector('[data-state="on"]');
  expect(line).not.toBeNull();
  expect(switched.dom.document.activeElement).toBe(line);

  restore.splice(0).forEach((undo) => undo());
  const refused = await mount({
    "activation/preview": () => ({ json: { data: preview() } }),
    activate: () => ({ json: { data: { state: "failed", failure: { reason: "Owner authority changed." } } } }),
  });
  press(refused.dom.root, "Switch on");
  await tick();
  expect(refused.dom.document.activeElement).toBe(button(refused.dom.root, "Try again")!);
});

test("a schedule says when it runs, and an app's Code names the service account its pages run with", async () => {
  const automations = [
    { entrypoint: "weekly", cron: "0 8 * * 1" },
    { entrypoint: "morning", title: "Every morning", cron: "0 7 * * *" },
    { entrypoint: "route:GET:/", route: { method: "GET", path: "/", public: false } },
  ];
  const { dom } = await mount({
    "activation/preview": () => ({ json: { data: preview({ ownerKind: "app", appName: "Mail", place: null, targets: [], automations }) } }),
  });
  expect(dom.root.textContent).toContain("Mondays 08:00 · Every morning (daily 07:00) · GET /");
  expect(dom.root.textContent).not.toContain("weekly");
  expect(dom.root.textContent).toContain("runs with the rights of the service account “Code of Mail”");
});

test("a person who moved on while the switch waited keeps their place when the result arrives", async () => {
  let answer = () => {};
  const answered = new Promise<void>((resolve) => {
    answer = resolve;
  });
  const { dom } = await mount({
    "activation/preview": () => ({ json: { data: preview() } }),
    activate: async () => {
      await answered;
      return { json: { data: { state: "failed", failure: { reason: "Owner authority changed." } } } };
    },
  });
  const switchOn = button(dom.root, "Switch on")!;
  switchOn.focus();
  switchOn.click();
  const composer = dom.document.createElement("textarea");
  dom.document.body.append(composer);
  composer.focus();
  answer();
  await tick();
  expect(button(dom.root, "Try again")).toBeDefined();
  expect(dom.document.activeElement).toBe(composer);
});
