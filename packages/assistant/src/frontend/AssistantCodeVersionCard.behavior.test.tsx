import { afterEach, expect, spyOn, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { codeVersionPageHref } from "./AssistantCodeVersionCard";
import type { CodeVersionPreview, CodeVersionPreviewRow } from "./code-activation";

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const codeId = "c_info01";
const versionId = "66666666-6666-4666-8666-666666666666";

const row = (patch: Partial<CodeVersionPreviewRow>): CodeVersionPreviewRow => ({
  target: { type: "spaces.space", id: "sp_2lg8" },
  operations: ["spaces.task.create"],
  own: false,
  isNew: true,
  check: "manages",
  title: "Logistics",
  typeTitle: "Space",
  managers: [],
  ...patch,
});
const own = row({
  target: { type: "mail.mailbox", id: "m_info" },
  operations: ["mail.conversation.move"],
  own: true,
  title: "info@example.test",
  typeTitle: "mailbox",
});
const preview = (patch: Partial<CodeVersionPreview> = {}): CodeVersionPreview => ({
  codeId,
  title: "Code of info@",
  versionId,
  number: 5,
  running: 4,
  latest: 5,
  activated: null,
  allowed: { allowed: true },
  readiness: { state: "ready" },
  place: { title: "info@example.test", typeTitle: "mailbox", href: "/app/mail/m_info" },
  rows: [own, row({})],
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

test("someone who manages every target sees the rights, Switch on and the difference", async () => {
  const { dom } = await mount({ "activation/preview": () => ({ json: { data: preview() } }) });
  const text = dom.root.textContent ?? "";
  expect(text).toContain("Version 5 of “Code of info@” is ready.");
  expect(text).toContain("mail.conversation.move");
  expect(text).toContain("on its own mailbox");
  expect(text).toContain("belongs to info@example.test");
  expect(text).toContain("at Space Logistics (sp_2lg8)");
  expect(text).toContain("you manage it");
  expect(button(dom.root, "Switch on")).toBeDefined();
  expect(button(dom.root, "Difference")?.getAttribute("href")).toBe(`/app/mail/m_info/code?tab=versions&version=${versionId}`);
});

test("someone who cannot switch on learns why and who can, and copies a link for them", async () => {
  const blocked = row({ check: "blocked", managers: [{ name: "Ben Schulz", firstName: "Ben" }] });
  const { dom } = await mount({ "activation/preview": () => ({ json: { data: preview({ rows: [own, blocked] }) } }) });
  const text = dom.root.textContent ?? "";
  expect(text).toContain("needs the Space's admin");
  expect(text).toContain("Only someone who manages mailbox and Space can switch this on: Ben Schulz.");
  expect(text).toContain("Until then version 4 keeps running.");
  expect(button(dom.root, "Switch on")).toBeUndefined();
  expect(button(dom.root, "Copy link for Ben")).toBeDefined();
  expect(button(dom.root, "Difference")).toBeDefined();
});

test("a target the person may not read stays an ID, with no name of who manages it", async () => {
  const hidden = row({ check: "blocked", title: null, typeTitle: null });
  const { dom } = await mount({ "activation/preview": () => ({ json: { data: preview({ rows: [own, hidden] }) } }) });
  const text = dom.root.textContent ?? "";
  expect(text).toContain("at sp_2lg8");
  expect(text).toContain("Only someone who manages sp_2lg8 can switch this on.");
  expect(button(dom.root, "Copy link")?.textContent).toContain("Copy link");
  expect(text).not.toContain("Logistics");
});

test("switching on runs Core's activation and the card becomes one line, the same after a reload", async () => {
  let on = false;
  const { dom, calls, activated } = await mount({
    "activation/preview": () => ({
      json: {
        data: on ? preview({ running: 5, rows: [], activated: { at: "2026-10-31T14:20:00.000Z", byYou: true, byName: null } }) : preview(),
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
    activate: () => ({ json: { data: { state: "failed", failure: { reason: "The target refused." } } } }),
  });
  button(dom.root, "Switch on")!.click();
  await tick();
  expect(dom.root.textContent).toContain("The target refused. Nothing changed, version 4 keeps running.");
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

test("a phone sees the rights and why it cannot switch on; waiting for approval offers no switch", async () => {
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
  const older = await mount({ "activation/preview": () => ({ json: { data: preview({ latest: 6, rows: [] }) } }) });
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
  expect(codeVersionPageHref(preview({ place: null }))).toBe(`/app/assistant/code/${codeId}`);
  expect(codeVersionPageHref(preview({ place: { title: "info@", typeTitle: null, href: null } }))).toBeNull();
});
