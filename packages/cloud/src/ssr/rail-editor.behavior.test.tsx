import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { RailPreferences } from "../contracts/rail-preferences";
import type { RailApp } from "./rail-navigation";

const settle = async (done: () => boolean) => {
  for (let attempt = 0; !done() && attempt < 300; attempt += 1) await Bun.sleep(5);
  return done();
};
const app = (id: string, label: string): RailApp => ({ id, label, href: `/app/${id}`, match: `/app/${id}`, iconClass: "ti ti-box", defaultVisible: true });
const apps = [app("chat", "Chat"), app("files", "Files"), app("mail", "Mail")];

let dom: ReturnType<typeof createDomTestHarness>;
let stored: RailPreferences;
let writes: RailPreferences[];
let failNext: boolean;
let dispose: () => void;
let fetchSpy: { mockRestore(): void };
let canvas: HTMLElement;

// One document for the file: Solid binds delegated events to the document that loads a module first.
beforeAll(() => {
  dom = createDomTestHarness();
});
afterAll(() => dom.cleanup());

beforeEach(async () => {
  stored = { revision: 2, visibility: {}, shortcuts: [], showNames: true };
  writes = [];
  failNext = false;
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<script id="cloud-shell-data" type="application/json">${JSON.stringify({ apps, rail: stored, legalLinks: [], theme: "light", searchLinks: {} })}</script>`,
  );
  canvas = document.createElement("div");
  canvas.className = "cloud-app-canvas";
  canvas.innerHTML = '<aside class="layout-rail" data-rail-names=""><nav></nav></aside>';
  document.body.append(canvas);
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(new URL(String(input), "http://cloud.test"), init);
        if (new URL(request.url).pathname !== "/api/me/rail") throw new Error(`Unexpected request ${request.url}`);
        if (request.method !== "PUT") return Response.json(stored);
        const body: RailPreferences = await request.json();
        writes.push(body);
        if (failNext) {
          failNext = false;
          return new Response("unavailable", { status: 503 });
        }
        if (body.revision !== stored.revision) return Response.json({ code: "CONFLICT" }, { status: 409 });
        stored = { ...body, revision: stored.revision + 1 };
        return Response.json(stored);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  const { default: RailApps } = await import("./RailApps");
  dispose = render(() => createComponent(RailApps, { apps, settings: stored, currentPath: "/" }), canvas.querySelector("nav")!);
  const { openRailEditor } = await import("./RailEditor");
  openRailEditor("en");
  await settle(() => !!document.querySelector("dialog .rail-editor"));
});

afterEach(async () => {
  document.querySelector<HTMLButtonElement>("dialog .k2b-dialog__close, dialog [aria-label='Close']")?.click();
  await Bun.sleep(20);
  dispose();
  fetchSpy.mockRestore();
  document.getElementById("cloud-shell-data")?.remove();
  canvas.remove();
});

const dialog = () => document.querySelector("dialog")!;
const button = (name: string) => dialog().querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
const rows = (selector: string) => [...dialog().querySelectorAll(`${selector} .rail-editor-row__title`)].map((title) => title.textContent);
const idle = () => settle(() => dialog().querySelector(".rail-editor-state")?.getAttribute("data-state") !== "saving");

test("one list in the app bar's order, every change saved at once, without a save button", async () => {
  expect(dialog().querySelector(".rail-editor-state")?.textContent).toBe("Saves instantly");
  expect([...dialog().querySelectorAll("button")].some((element) => element.textContent === "Save")).toBe(false);
  expect(rows(".rail-editor-apps")).toEqual(["Chat", "Files", "Mail"]);
  dialog().querySelector<HTMLInputElement>('.rail-editor-names input[role="switch"]')!.click();
  await settle(() => writes.length === 1);
  await idle();
  expect(writes[0]).toEqual({ revision: 2, visibility: {}, shortcuts: [], showNames: false });
  expect(canvas.querySelector(".layout-rail")!.hasAttribute("data-rail-names")).toBe(false);
  expect(dialog().querySelector(".rail-editor-state")?.textContent).toBe("Saved");

  // Pinning moves the app up into the pinned entries at once; the app bar follows the saved state.
  button("Pin Mail")!.click();
  expect(rows(".rail-editor-pinned")).toEqual(["Mail"]);
  expect(rows(".rail-editor-apps")).toEqual(["Chat", "Files"]);
  await settle(() => writes.length === 2);
  await idle();
  expect(stored.shortcuts).toEqual([{ id: expect.any(String), kind: "app", appId: "mail" }]);

  // A hidden app stays where it is, paler.
  dialog().querySelector<HTMLInputElement>('input[aria-label="Show Chat in the app bar"]')!.click();
  expect(rows(".rail-editor-apps")).toEqual(["Chat", "Files"]);
  expect(dialog().querySelector(".rail-editor-apps .rail-editor-row")!.hasAttribute("data-off")).toBe(true);
  await settle(() => writes.length === 3);
  await idle();
  expect(stored.visibility).toEqual({ chat: false });
});

test("a step that fails goes back alone, marks its row, and Try again saves it", async () => {
  failNext = true;
  button("Pin Files")!.click();
  await settle(() => !!dialog().querySelector(".rail-editor-failure"));
  expect(dialog().querySelector(".rail-editor-failure")?.textContent).toContain("The last change to “Files” was not saved.");
  expect(dialog().querySelector(".rail-editor-state")?.textContent).toBe("Not saved");
  // The pin went back: Files is among the other apps again, with the mark.
  expect(rows(".rail-editor-pinned")).toEqual([]);
  const files = [...dialog().querySelectorAll(".rail-editor-apps .rail-editor-row")].find((row) => row.textContent?.includes("Files"))!;
  expect(files.querySelector(".rail-editor-row__failed")?.getAttribute("aria-label")).toBe("The last change to “Files” was not saved.");
  [...dialog().querySelectorAll<HTMLButtonElement>(".rail-editor-failure button")].find((element) => element.textContent === "Try again")!.click();
  await settle(() => stored.shortcuts.length === 1);
  await idle();
  expect(dialog().querySelector(".rail-editor-failure")).toBeNull();
  expect(rows(".rail-editor-pinned")).toEqual(["Files"]);
});

test("the keyboard reorders pinned entries from the grip, and the grip keeps focus", async () => {
  button("Pin Chat")!.click();
  button("Pin Mail")!.click();
  await settle(() => stored.shortcuts.length === 2);
  await idle();
  const grip = button("Move Mail")!;
  grip.focus();
  grip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  expect(rows(".rail-editor-pinned")).toEqual(["Mail", "Chat"]);
  await settle(() => stored.shortcuts[0]?.kind === "app" && stored.shortcuts[0].appId === "mail");
  await idle();
  expect(stored.shortcuts.map((entry) => (entry.kind === "app" ? entry.appId : entry.id))).toEqual(["mail", "chat"]);
  // The saved copy of each entry reaches its row in place: the grip is the same element and keeps focus.
  expect(document.activeElement).toBe(grip);
});

test("closing never asks, saving goes on, and a step that fails later says so with a way back", async () => {
  failNext = true;
  button("Pin Chat")!.click();
  button("Close")!.click();
  await settle(() => !document.querySelector("dialog[open] .rail-editor"));
  expect(document.querySelector("dialog[open] .rail-editor")).toBeNull();
  const toastShown = await settle(() => document.body.textContent?.includes("A change to your app bar was not saved.") ?? false);
  expect(toastShown).toBe(true);
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === "Open")!.click();
  await settle(() => !!document.querySelector("dialog .rail-editor-failure"));
  expect(document.querySelector("dialog .rail-editor-failure")?.textContent).toContain("“Chat”");
});

test("Reset saves at once and its Undo brings the earlier entries back", async () => {
  button("Pin Chat")!.click();
  dialog().querySelector<HTMLInputElement>('input[aria-label="Show Files in the app bar"]')!.click();
  await settle(() => stored.shortcuts.length === 1 && stored.visibility.files === false);
  await idle();
  [...dialog().querySelectorAll<HTMLButtonElement>(".rail-editor-reset button")][0]!.click();
  await settle(() => stored.shortcuts.length === 0);
  await idle();
  expect(stored.visibility).toEqual({});
  const undo = await settle(() => [...document.querySelectorAll("button")].some((element) => element.textContent === "Undo"));
  expect(undo).toBe(true);
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === "Undo")!.click();
  await settle(() => stored.shortcuts.length === 1);
  await idle();
  expect(stored).toMatchObject({ visibility: { files: false }, shortcuts: [{ kind: "app", appId: "chat" }] });
});
