import { afterEach, beforeEach, expect, test } from "bun:test";
import { AppApprovalClientError } from "@k2b/cloud/browser/app-approval";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../packages/ui/test/dom";
import type { Authenticator } from "./authenticator";
import type { Preferences } from "./preferences";
import type { Binding, CloudDetails } from "./storage";

let dom: DomTestHarness;
let dispose = () => {};
beforeEach(() => {
  dom = createDomTestHarness();
});
afterEach(async () => {
  const { closeDialogs } = await import("./dialog");
  closeDialogs();
  await Bun.sleep(20);
  dispose();
  dom.cleanup();
});

const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
const binding: Binding = {
  id: "fixture",
  label: "StuVe Cloud",
  name: "My phone",
  issuer: "https://cloud.example.org",
  deviceId: "device",
  key: { privateKey: keys.privateKey, publicKey: { kty: "EC", crv: "P-256", x: "unused", y: "unused" } },
};
const details: CloudDetails = {
  uid: "vkolb",
  displayName: "Valentin Kolb",
  mail: "valentin@example.org",
  deviceName: "iPhone",
  pairedAt: "2026-09-01T10:00:00.000Z",
  checkedAt: "2026-09-20T08:30:00.000Z",
};

function fakeAuth(options: { online?: boolean; stored?: Binding; account?: () => Promise<CloudDetails> }) {
  const calls: string[] = [];
  const noop = async () => {};
  const auth: Authenticator = {
    bindings: () => [binding],
    states: () => ({ fixture: { requests: [] } }),
    now: Date.now,
    online: () => options.online ?? true,
    storageError: () => false,
    changed: noop,
    client: async () => {
      throw new Error("No network in this test");
    },
    stored: async () => options.stored,
    account: async (value) => {
      calls.push(value.id);
      return (options.account ?? (async () => details))();
    },
    decide: noop,
    revoke: noop,
    syncPush: noop,
    forget: noop,
    rename: noop,
  };
  return { auth, calls };
}

async function showDetails(auth: Authenticator, locale: "en" | "de" = "en") {
  const { LocaleProvider } = await import("@k2b/ui");
  const { Clouds } = await import("./Clouds");
  const preferences: Preferences = {
    locale: () => locale,
    language: () => locale,
    theme: () => "light",
    setLanguage: () => {},
    setTheme: () => {},
  };
  // main.tsx provides the app language to the page; dialogs receive it again from the preferences.
  dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(Clouds, { auth, preferences });
        },
      }),
    dom.root,
  );
  const button = dom.root.querySelector<HTMLButtonElement>(".auth-cloud header .auth-cloud-info");
  expect(button).not.toBeNull();
  button!.click();
  await Bun.sleep(40);
  const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
  expect(dialog).not.toBeNull();
  return { button: button!, dialog: dialog! };
}

const text = (element: Element) => element.textContent?.replace(/\s+/g, " ") ?? "";

test("the card's info button shows the account this device signs in", async () => {
  const { auth, calls } = fakeAuth({ stored: { ...binding, approvedAt: "2026-09-25T18:05:00.000Z" } });
  const { button, dialog } = await showDetails(auth);
  expect(button.getAttribute("aria-label")).toBe("Details for StuVe Cloud");
  expect(calls).toEqual(["fixture"]);
  expect(dialog.querySelector("h2")?.textContent).toBe("StuVe Cloud");
  expect(text(dialog)).toContain("https://cloud.example.org");
  const terms = [...dialog.querySelectorAll("dt")].map((term) => term.textContent);
  const values = [...dialog.querySelectorAll("dd")].map((value) => value.textContent);
  expect(terms).toEqual(["Username", "Name", "Email", "Device name", "Paired since", "Last approval"]);
  expect(values.slice(0, 4)).toEqual(["vkolb", "Valentin Kolb", "valentin@example.org", "iPhone"]);
  expect(values[4]).toContain("2026");
  expect(values[5]).toContain("2026");
  expect(dialog.querySelector('[aria-label="Copy username"]')).not.toBeNull();
  expect(dialog.querySelector('[role="status"]')).toBeNull();
  [...dialog.querySelectorAll<HTMLButtonElement>("header button")].find((b) => b.getAttribute("aria-label") === "Close")!.click();
  await Bun.sleep(40);
  expect(document.querySelector("dialog[open]")).toBeNull();
});

test("offline, the saved copy is shown with its date and the Cloud is not contacted", async () => {
  const { auth, calls } = fakeAuth({ online: false, stored: { ...binding, details: { ...details, mail: null, displayName: "" } } });
  const { dialog } = await showDetails(auth);
  expect(calls).toEqual([]);
  expect(text(dialog.querySelector('[role="status"]')!)).toContain("This Cloud cannot be reached right now. Showing details saved on");
  const terms = [...dialog.querySelectorAll("dt")].map((term) => term.textContent);
  expect(terms).toEqual(["Username", "Email", "Device name", "Paired since"]);
  expect(text(dialog)).toContain("vkolb");
  expect(text(dialog)).toContain("Not set");
});

test("without a saved copy, an unreachable or older Cloud explains why account details are missing", async () => {
  const unreachable = fakeAuth({
    account: async () => {
      throw new AppApprovalClientError("NETWORK");
    },
  });
  let { dialog } = await showDetails(unreachable.auth);
  expect(text(dialog.querySelector('[role="status"]')!)).toBe(
    "This Cloud cannot be reached right now. Account details appear once it is reachable.",
  );
  expect([...dialog.querySelectorAll("dt")].map((term) => term.textContent)).toEqual(["Device name"]);
  expect(text(dialog)).toContain("My phone");
  const { closeDialogs } = await import("./dialog");
  closeDialogs();
  await Bun.sleep(40);
  dispose();

  const older = fakeAuth({
    account: async () => {
      throw new AppApprovalClientError("HTTP", 400);
    },
  });
  ({ dialog } = await showDetails(older.auth));
  expect(text(dialog.querySelector('[role="status"]')!)).toBe(
    "This Cloud does not share account details yet. They appear once the Cloud is updated.",
  );
});

test("German labels follow the app language", async () => {
  const { auth } = fakeAuth({});
  const { button, dialog } = await showDetails(auth, "de");
  expect(button.getAttribute("aria-label")).toBe("Details zu StuVe Cloud");
  expect([...dialog.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual(["Konto", "Dieses Gerät"]);
  expect([...dialog.querySelectorAll("dt")].map((term) => term.textContent)).toEqual([
    "Benutzername",
    "Name",
    "E-Mail",
    "Gerätename",
    "Gekoppelt seit",
  ]);
  expect(dialog.querySelector('[aria-label="Benutzername kopieren"]')).not.toBeNull();
});
