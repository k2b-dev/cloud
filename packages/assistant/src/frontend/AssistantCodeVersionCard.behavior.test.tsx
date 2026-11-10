import { afterEach, expect, spyOn, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { type CodeVersionPreview, codeVersionPageHref } from "./code-activation";

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
  ...patch,
});

const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

/** Mounts the card with Core's routes answered by `routes`; a missing route is an outage. */
const mount = async (routes: Record<string, (body: unknown) => { status?: number; json?: unknown }>) => {
  const dom = createDomTestHarness();
  const calls: Array<{ route: string; body: unknown }> = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url: string, init?: RequestInit) => {
    const route = String(url).replace("/api/code/", "");
    const body = JSON.parse(String(init?.body ?? "null"));
    calls.push({ route, body });
    const answer = routes[route]?.(body);
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
  const { dom } = await mount({ "activation/preview": () => ({ json: { data: preview({ targets }) } }) });
  const rows = [...dom.root.querySelectorAll(".assistant-code-version__target")].map((row) => row.textContent);
  expect(dom.root.textContent).toContain("What this version calls");
  expect(rows).toEqual([
    "at info@example.test itself",
    "mail.message.readmail.message.moveat Mailbox m_billingnew",
    "spaces.task.createwhere the Code picks it while running",
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

test("the Code page is the place's own /code page, or a personal Code's page in Gustav", () => {
  expect(codeVersionPageHref(preview())).toBe("/app/mail/m_info/code");
  expect(codeVersionPageHref(preview({ ownerKind: "person", place: null }))).toBe(`/app/assistant/code/${codeId}`);
  // A place the person may not read has no address; Code of a place is never sent to a personal page.
  expect(codeVersionPageHref(preview({ place: null }))).toBeNull();
  expect(codeVersionPageHref(preview({ place: { title: "info@", typeTitle: null, href: null } }))).toBeNull();
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
