import { afterAll, beforeAll, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../packages/ui/test/dom";
import type { Authenticator, InboxState, Login } from "./authenticator";
import { type DecisionState, decisionStates } from "./decision.browser-harness";
import type { Preferences } from "./preferences";
import type { Binding } from "./storage";

// Who asks, as the sign-in sheet shows it: one test per state, with the device clock and zone pinned.
const zone = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Europe/Vienna";
});
afterAll(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

const createdAt = "2026-10-24T07:14:00.000Z";
const expiresAt = "2026-10-24T07:19:00.000Z";
const noop = async () => {};

type Answer = "ok" | "lost" | "hang";
async function openSheet(options: {
  locale: "en" | "de";
  context?: Login["context"];
  terminal?: boolean;
  answer?: Answer;
  queued?: boolean;
}) {
  const dom = createDomTestHarness();
  const { Clouds } = await import("./Clouds");
  const { closeDialogs } = await import("./dialog");
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const binding: Binding = {
    id: "fixture",
    label: "Hoffmann Druck",
    name: "Hoffmann",
    issuer: "https://cloud.hoffmann-druck.test",
    deviceId: "device",
    key: { privateKey: keys.privateKey, publicKey: { kty: "EC", crv: "P-256", x: "unused", y: "unused" } },
  };
  const request: Login = {
    requestId: "login",
    comparison: "623775",
    challenge: "unused",
    createdAt,
    expiresAt,
    ...(options.terminal ? { terminal: { client: { id: "cloud-cli", name: "Cloud CLI" }, scopes: ["read"], lifetimeSeconds: 28800 } } : {}),
    ...(options.context ? { context: options.context } : {}),
  };
  const second: Login = { ...request, requestId: "second", createdAt: "2026-10-24T07:14:30.000Z" };
  const [inbox, setInbox] = createSignal<Record<string, InboxState>>({
    fixture: { requests: options.queued ? [request, second] : [request], actions: [], moreActions: 0, changes: [], moreChanges: 0 },
  });
  const [now, setNow] = createSignal(Date.parse("2026-10-24T07:15:00.000Z"));
  const [online, setOnline] = createSignal(true);
  const [bindings, setBindings] = createSignal([binding]);
  const decisions: string[] = [];
  const auth: Authenticator = {
    bindings,
    states: inbox,
    now,
    online,
    storageError: () => false,
    changed: noop,
    client: async () => {
      throw new Error("No network in this test");
    },
    stored: async () => undefined,
    account: async () => {
      throw new Error("No network in this test");
    },
    action: async () => {
      throw new Error("No action in this test");
    },
    act: noop,
    decideChange: noop,
    decide: async (_binding, decided, decision) => {
      decisions.push(decision);
      if (options.answer === "lost") throw new Error("The response was lost");
      if (options.answer === "hang") return new Promise<void>(() => {});
      const current = inbox().fixture!;
      setInbox({ fixture: { ...current, requests: current.requests.filter((item) => item.requestId !== decided.requestId) } });
    },
    revoke: noop,
    syncPush: noop,
    forget: noop,
    rename: noop,
  };
  const preferences: Preferences = {
    locale: () => options.locale,
    language: () => options.locale,
    theme: () => "light",
    setLanguage: () => {},
    setTheme: () => {},
  };
  const dispose = render(() => createComponent(Clouds, { auth, preferences }), dom.root);
  await Bun.sleep(30);
  const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
  const lines = () => [...dialog.querySelectorAll(".auth-decision__details[data-context] dd")].map((dd) => dd.textContent);
  const note = () =>
    dialog.querySelector<HTMLElement>(
      ".auth-decision__request .k2b-notice-card[data-tone='info'], .auth-decision__request .k2b-notice-card[data-tone='warning']",
    );
  const choices = () => [...dialog.querySelectorAll<HTMLButtonElement>(".auth-decision-actions__choices button")];
  return {
    dialog,
    lines,
    note,
    choices,
    decisions,
    request,
    inbox,
    setInbox,
    setNow,
    setOnline,
    setBindings,
    cleanup: async () => {
      closeDialogs();
      await Bun.sleep(20);
      dispose();
      dom.cleanup();
    },
  };
}

// Every line in both languages, from the concept's table; a state without a value shows no line for it.
const expected: Record<Exclude<DecisionState, "legacy">, { en: string[]; de: string[]; note?: { en: string; de: string }; warn?: true }> = {
  known: {
    en: [
      "Firefox on Windows",
      "Approximately Wien, Austria",
      "Network: Magenta Telekom",
      "Same internet address as this phone",
      "Started at 09:14",
      "Known browser · since 03/12/2026",
    ],
    de: [
      "Firefox auf Windows",
      "Ungefähr Wien, Österreich",
      "Netz: Magenta Telekom",
      "Gleiche Internetadresse wie dieses Telefon",
      "Gestartet um 09:14",
      "Bekannter Browser · seit 12.03.2026",
    ],
  },
  first: {
    en: ["Chrome on macOS", "Approximately Wien, Austria", "Network: A1 Telekom Austria", "Started at 09:14"],
    de: ["Chrome auf macOS", "Ungefähr Wien, Österreich", "Netz: A1 Telekom Austria", "Gestartet um 09:14"],
    note: { en: "Cloud does not know this browser yet", de: "Cloud kennt diesen Browser noch nicht" },
  },
  country: {
    en: [
      "Safari on Mac or iPad",
      "Approximately Rom, Italy",
      "Network: Telecom Italia",
      "Started at 09:14",
      "Known browser · since 05/02/2026",
    ],
    de: [
      "Safari auf Mac oder iPad",
      "Ungefähr Rom, Italien",
      "Netz: Telecom Italia",
      "Gestartet um 09:14",
      "Bekannter Browser · seit 02.05.2026",
    ],
    note: { en: "No sign-in from this country in the last 90 days", de: "In den letzten 90 Tagen keine Anmeldung aus diesem Land" },
  },
  since: {
    en: [
      "Safari on Mac or iPad",
      "Approximately Rom, Italy",
      "Network: Telecom Italia",
      "Started at 09:14",
      "Known browser · since 05/02/2026",
    ],
    de: [
      "Safari auf Mac oder iPad",
      "Ungefähr Rom, Italien",
      "Netz: Telecom Italia",
      "Gestartet um 09:14",
      "Bekannter Browser · seit 02.05.2026",
    ],
    note: { en: "No sign-in from this country since 09/01/2026", de: "Seit 01.09.2026 keine Anmeldung aus diesem Land" },
  },
  network: {
    en: ["Chrome on Windows", "Approximately Frankfurt am Main, Germany", "Network: Hetzner Online", "Started at 09:14"],
    de: ["Chrome auf Windows", "Ungefähr Frankfurt am Main, Deutschland", "Netz: Hetzner Online", "Gestartet um 09:14"],
    note: { en: "Cloud does not know this browser yet", de: "Cloud kennt diesen Browser noch nicht" },
  },
  nogeo: {
    en: ["Firefox on Windows", "Same internet address as this phone", "Started at 09:14", "Known browser · since 03/12/2026"],
    de: ["Firefox auf Windows", "Gleiche Internetadresse wie dieses Telefon", "Gestartet um 09:14", "Bekannter Browser · seit 12.03.2026"],
  },
  sparse: {
    en: ["Unknown browser", "Approximately Austria", "Network unknown", "Started at 09:14", "Known browser · since 03/12/2026"],
    de: ["Unbekannter Browser", "Ungefähr Österreich", "Netz nicht bekannt", "Gestartet um 09:14", "Bekannter Browser · seit 12.03.2026"],
  },
  noplace: {
    en: ["Edge on Linux", "Location unknown", "Network: Example Networks", "Started at 09:14"],
    de: ["Edge auf Linux", "Ort nicht bekannt", "Netz: Example Networks", "Gestartet um 09:14"],
    note: { en: "Cloud does not know this browser yet", de: "Cloud kennt diesen Browser noch nicht" },
  },
  intro: {
    en: [
      "Firefox on Windows",
      "Approximately Wien, Austria",
      "Network: Magenta Telekom",
      "Same internet address as this phone",
      "Started at 09:14",
    ],
    de: [
      "Firefox auf Windows",
      "Ungefähr Wien, Österreich",
      "Netz: Magenta Telekom",
      "Gleiche Internetadresse wie dieses Telefon",
      "Gestartet um 09:14",
    ],
  },
  warn: {
    en: ["Edge on Windows", "Approximately Warschau, Poland", "Network: OVH", "Started at 09:14"],
    de: ["Edge auf Windows", "Ungefähr Warschau, Polen", "Netz: OVH", "Gestartet um 09:14"],
    note: {
      en: "Did you start this sign-in?Cloud does not know this browser, and there was no sign-in from this country in the last 90 days. If not, deny it.",
      de: "Hast du diese Anmeldung gestartet?Cloud kennt den Browser nicht, und in den letzten 90 Tagen gab es keine Anmeldung aus diesem Land. Wenn nicht, lehne ab.",
    },
    warn: true,
  },
  warnSince: {
    en: ["Edge on Windows", "Approximately Warschau, Poland", "Network: OVH", "Started at 09:14"],
    de: ["Edge auf Windows", "Ungefähr Warschau, Polen", "Netz: OVH", "Gestartet um 09:14"],
    note: {
      en: "Did you start this sign-in?Cloud does not know this browser, and there has been no sign-in from this country since 09/01/2026. If not, deny it.",
      de: "Hast du diese Anmeldung gestartet?Cloud kennt den Browser nicht, und seit 01.09.2026 gab es keine Anmeldung aus diesem Land. Wenn nicht, lehne ab.",
    },
    warn: true,
  },
};

for (const [state, want] of Object.entries(expected) as [Exclude<DecisionState, "legacy">, (typeof expected)[keyof typeof expected]][]) {
  for (const locale of ["en", "de"] as const) {
    test(`the ${state} sign-in shows who asks above the code, ${locale}`, async () => {
      const sheet = await openSheet({ locale, context: decisionStates[state] });
      try {
        expect(sheet.lines()).toEqual(want[locale]);
        // The place starts with "approximately"; the country never stands in a sentence.
        const country = sheet
          .lines()
          .filter(
            (line) => !/^(Network|Netz)/.test(line!) && /Austria|Österreich|Italy|Italien|Germany|Deutschland|Poland|Polen/.test(line!),
          );
        for (const line of country) expect(line).toMatch(/^(Approximately|Ungefähr) /);
        expect(sheet.note()?.textContent ?? undefined).toBe(want.note?.[locale]);
        expect(sheet.dialog.textContent).not.toMatch(/VPN|data cent|Rechenzentrum/i);
        // Every row has a term a screen reader can read; the icon alone is hidden from it.
        const terms = [...sheet.dialog.querySelectorAll(".auth-decision__details[data-context] dt")];
        expect(terms).toHaveLength(want[locale].length);
        for (const term of terms) expect(term.querySelector(".k2b-sr-only")?.textContent).toBeTruthy();
        // The rows, the note and the hint stand above the code, and the code is the request's last part.
        const request = sheet.dialog.querySelector(".auth-decision__request")!;
        expect(request.lastElementChild?.matches("output.auth-comparison")).toBe(true);
        expect([...request.children].map((child) => child.className.split(" ")[0])).toEqual([
          "auth-action-details",
          ...(want.note ? ["k2b-notice-card"] : []),
          "auth-decision__hint",
          "auth-comparison",
        ]);
        // A screen reader hears the note with the dialog's name.
        const describedBy = sheet.dialog.getAttribute("aria-describedby");
        if (want.note) expect(describedBy && document.getElementById(describedBy)).toBe(sheet.note());
        else expect(describedBy).toBeNull();
        // After a warning, Deny is the main action in the first place and Approve stays second, renamed.
        const [deny, approve] = sheet.choices();
        expect(deny?.textContent).toBe(locale === "de" ? "Ablehnen" : "Deny");
        expect(deny?.dataset.variant).toBe(want.warn ? "primary" : "secondary");
        expect(approve?.dataset.variant).toBe(want.warn ? "secondary" : "primary");
        expect(approve?.textContent).toBe(
          want.warn
            ? locale === "de"
              ? "Trotzdem erlauben"
              : "Approve anyway"
            : locale === "de"
              ? "Anmeldung erlauben"
              : "Approve sign-in",
        );
      } finally {
        await sheet.cleanup();
      }
    });
  }
}

test("a Cloud without login context shows the earlier sheet with the start time", async () => {
  const sheet = await openSheet({ locale: "de" });
  try {
    expect(sheet.dialog.querySelector(".auth-decision__details")).toBeNull();
    expect(sheet.note()).toBeNull();
    expect(sheet.dialog.querySelector(".auth-decision__started")?.textContent).toBe("Gestartet um 09:14");
    expect(sheet.dialog.querySelector(".auth-decision__hint > p")?.textContent).toBe(
      "Bestätige nur eine selbst gestartete Anmeldung. Vergleiche diesen Code mit dem wartenden Browser.",
    );
    expect(sheet.dialog.hasAttribute("aria-describedby")).toBe(false);
    expect(sheet.choices().map((button) => [button.textContent, button.dataset.variant])).toEqual([
      ["Ablehnen", "secondary"],
      ["Anmeldung erlauben", "primary"],
    ]);
  } finally {
    await sheet.cleanup();
  }
});

test("a terminal sign-in keeps its sheet, also when it carried context", async () => {
  const sheet = await openSheet({ locale: "en", terminal: true, context: decisionStates.warn });
  try {
    expect(sheet.dialog.querySelector(".auth-decision__details[data-context]")).toBeNull();
    expect(sheet.dialog.querySelector(".auth-decision__hint")).toBeNull();
    expect(sheet.note()).toBeNull();
    const request = sheet.dialog.querySelector(".auth-decision__request")!;
    expect(request.lastElementChild?.matches("dl.auth-decision__details")).toBe(true);
    expect([...request.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["Cloud", "Valid for", "Permissions"]);
    expect(sheet.choices().map((button) => button.textContent)).toEqual(["Deny", "Approve sign-in"]);
  } finally {
    await sheet.cleanup();
  }
});

test("the sheet keeps the lines it opened with when a later poll changes the same-network hint", async () => {
  const sheet = await openSheet({ locale: "en", context: decisionStates.known });
  try {
    const opened = sheet.lines();
    expect(opened).toContain("Same internet address as this phone");
    // The phone moved from Wi-Fi to mobile data: the next poll no longer finds the same address.
    const { sameNetwork: _gone, ...moved } = decisionStates.known;
    sheet.setInbox({
      fixture: { requests: [{ ...sheet.request, context: moved }], actions: [], moreActions: 0, changes: [], moreChanges: 0 },
    });
    await Bun.sleep(30);
    expect(document.querySelector("dialog[open]")).toBe(sheet.dialog);
    expect(sheet.lines()).toEqual(opened);
  } finally {
    await sheet.cleanup();
  }
  const quiet = await openSheet({ locale: "en", context: decisionStates.first });
  try {
    const opened = quiet.lines();
    quiet.setInbox({
      fixture: {
        requests: [{ ...quiet.request, context: { ...decisionStates.first, sameNetwork: true } }],
        actions: [],
        moreActions: 0,
        changes: [],
        moreChanges: 0,
      },
    });
    await Bun.sleep(30);
    expect(quiet.lines()).toEqual(opened);
    expect(quiet.lines()).not.toContain("Same internet address as this phone");
  } finally {
    await quiet.cleanup();
  }
});

test("only a poll that answers without the request closes the sheet; a cleared or failed list does not", async () => {
  const sheet = await openSheet({ locale: "en", context: decisionStates.known });
  try {
    // Offline or hidden, the authenticator clears the list: no answer about this request.
    sheet.setInbox({});
    await Bun.sleep(20);
    expect(document.querySelector("dialog[open]")).toBe(sheet.dialog);
    sheet.setInbox({ fixture: { requests: [], actions: [], moreActions: 0, changes: [], moreChanges: 0, error: "unavailable" } });
    await Bun.sleep(20);
    expect(document.querySelector("dialog[open]")).toBe(sheet.dialog);
    // Decided in another tab or on the Cloud: the next answered poll no longer lists it.
    sheet.setInbox({ fixture: { requests: [], actions: [], moreActions: 0, changes: [], moreChanges: 0 } });
    await Bun.sleep(20);
    expect(document.querySelector("dialog[open]")).toBeNull();
  } finally {
    await sheet.cleanup();
  }
});

test("a Cloud that refuses this phone closes the sheet; polling stops for it, so no answer would follow", async () => {
  const sheet = await openSheet({ locale: "en", context: decisionStates.known });
  try {
    sheet.setInbox({ fixture: { requests: [], actions: [], moreActions: 0, changes: [], moreChanges: 0, error: "forbidden" } });
    await Bun.sleep(20);
    expect(document.querySelector("dialog[open]")).toBeNull();
  } finally {
    await sheet.cleanup();
  }
});

test("a sheet whose binding is gone closes, as when the vault locks and clears the list", async () => {
  const sheet = await openSheet({ locale: "en", context: decisionStates.known });
  try {
    sheet.setBindings([]);
    sheet.setInbox({});
    await Bun.sleep(20);
    expect(document.querySelector("dialog[open]")).toBeNull();
  } finally {
    await sheet.cleanup();
  }
});

for (const locale of ["en", "de"] as const) {
  test(`denying a warned sign-in ends in place with Denied and focused Done, ${locale}`, async () => {
    const sheet = await openSheet({ locale, context: decisionStates.warn, queued: true });
    try {
      const [deny] = sheet.choices();
      deny!.click();
      await Bun.sleep(30);
      expect(sheet.decisions).toEqual(["deny"]);
      expect(document.querySelector("dialog[open]")).toBe(sheet.dialog);
      const result = sheet.dialog.querySelector<HTMLElement>(".auth-decision > .auth-action-result[data-outcome='denied']")!;
      expect(result.getAttribute("role")).toBe("status");
      expect(result.querySelector("h3")?.textContent).toBe(locale === "de" ? "Abgelehnt" : "Denied");
      expect(result.querySelector("p")?.textContent).toBe(
        locale === "de"
          ? "Niemand wurde angemeldet. Der wartende Browser zeigt „Die Anmeldung wurde abgelehnt“."
          : "Nobody was signed in. The waiting browser shows “Sign-in was declined”.",
      );
      // The ending's place was reserved from the first frame, including Denied.
      expect([...sheet.dialog.querySelectorAll(".auth-decision__sizer h3")].map((h3) => h3.textContent)).toContain(
        locale === "de" ? "Abgelehnt" : "Denied",
      );
      expect(sheet.dialog.querySelector(".auth-decision__request")?.getAttribute("aria-hidden")).toBe("true");
      expect(sheet.dialog.hasAttribute("aria-describedby")).toBe(false);
      const done = sheet.dialog.querySelector<HTMLButtonElement>(".auth-decision-actions__done button")!;
      expect(document.activeElement).toBe(done);
      // A stale reference to the old choice cannot send a second decision; Done closes, and the next request opens.
      sheet.choices()[1]!.click();
      done.click();
      await Bun.sleep(60);
      expect(sheet.decisions).toEqual(["deny"]);
      const next = document.querySelector<HTMLDialogElement>("dialog[open]");
      expect(next?.querySelector(".auth-decision > .auth-action-result[data-outcome]")).toBeNull();
    } finally {
      await sheet.cleanup();
    }
  });
}

for (const level of ["info", "hint"] as const) {
  test(`denying a sign-in at level ${level} closes the sheet as before`, async () => {
    const sheet = await openSheet({ locale: "en", context: level === "info" ? decisionStates.known : decisionStates.first });
    try {
      sheet.choices()[0]!.click();
      await Bun.sleep(30);
      expect(sheet.decisions).toEqual(["deny"]);
      expect(document.querySelector("dialog[open]")).toBeNull();
    } finally {
      await sheet.cleanup();
    }
  });
}

for (const phase of ["expired", "uncertain"] as const) {
  test(`a warned sign-in that ends ${phase} keeps its ending in place`, async () => {
    const sheet = await openSheet({ locale: "de", context: decisionStates.warn, answer: "lost" });
    try {
      if (phase === "expired") sheet.setNow(Date.parse(expiresAt));
      else sheet.choices()[1]!.click();
      await Bun.sleep(30);
      const result = sheet.dialog.querySelector(`.auth-decision > .auth-action-result[data-outcome='${phase}']`)!;
      expect(result.querySelector("h3")?.textContent).toBe(phase === "expired" ? "Abgelaufen" : "Nicht bestätigt");
      expect(result.getAttribute("role")).toBe(phase === "uncertain" ? "alert" : "status");
      expect(sheet.choices().every((button) => button.disabled)).toBe(true);
      expect(sheet.dialog.hasAttribute("aria-describedby")).toBe(false);
    } finally {
      await sheet.cleanup();
    }
  });
}

for (const level of ["warn", "info"] as const) {
  test(`while a ${level} decision is sent, the pressed button shows progress and both are locked`, async () => {
    const sheet = await openSheet({ locale: "de", context: level === "warn" ? decisionStates.warn : decisionStates.known, answer: "hang" });
    try {
      const pressed = level === "warn" ? 0 : 1;
      sheet.choices()[pressed]!.click();
      await Bun.sleep(30);
      expect(sheet.choices().map((button) => button.disabled)).toEqual([true, true]);
      expect(sheet.choices().map((button) => button.getAttribute("aria-busy") === "true")).toEqual([pressed === 0, pressed === 1]);
      // The labels stay in the buttons, so neither changes size.
      expect(sheet.choices().map((button) => button.textContent)).toEqual(
        level === "warn" ? ["Ablehnen", "Trotzdem erlauben"] : ["Ablehnen", "Anmeldung erlauben"],
      );
      sheet.choices()[1 - pressed]!.click();
      await Bun.sleep(10);
      expect(sheet.decisions).toHaveLength(1);
    } finally {
      await sheet.cleanup();
    }
  });
}

for (const state of ["warn", "legacy"] as const) {
  test(`offline, the reason replaces the code hint in the same cell and both choices are locked, ${state}`, async () => {
    const sheet = await openSheet({ locale: "de", context: decisionStates[state] });
    try {
      const hint = sheet.dialog.querySelector<HTMLElement>(".auth-decision__hint")!;
      const [explanation, offline] = [...hint.children] as HTMLElement[];
      expect(hint.hasAttribute("data-offline")).toBe(false);
      expect(offline!.getAttribute("aria-hidden")).toBe("true");
      expect(sheet.choices().every((button) => !button.disabled)).toBe(true);
      sheet.setOnline(false);
      await Bun.sleep(10);
      expect(hint.hasAttribute("data-offline")).toBe(true);
      expect(explanation!.getAttribute("aria-hidden")).toBe("true");
      expect(offline!.hasAttribute("aria-hidden")).toBe(false);
      expect(offline!.getAttribute("role")).toBe("status");
      expect(offline!.textContent).toBe("Du bist offline. Erlauben und Ablehnen gehen wieder, sobald du verbunden bist.");
      expect(sheet.choices().every((button) => button.disabled)).toBe(true);
      // The note and the rows stay; only the hint's place changes.
      expect(sheet.dialog.querySelector(".auth-decision__request")?.children.length).toBe(state === "warn" ? 4 : 3);
      sheet.setOnline(true);
      await Bun.sleep(10);
      expect(hint.hasAttribute("data-offline")).toBe(false);
      expect(sheet.choices().every((button) => !button.disabled)).toBe(true);
    } finally {
      await sheet.cleanup();
    }
  });
}

test("no sheet opens while Cloud Login is still looking for requests; it opens with its rows in place", async () => {
  const dom = createDomTestHarness();
  const { Clouds } = await import("./Clouds");
  const { closeDialogs } = await import("./dialog");
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const binding: Binding = {
    id: "fixture",
    label: "Hoffmann Druck",
    name: "Hoffmann",
    issuer: "https://cloud.hoffmann-druck.test",
    deviceId: "device",
    key: { privateKey: keys.privateKey, publicKey: { kty: "EC", crv: "P-256", x: "unused", y: "unused" } },
  };
  const [inbox, setInbox] = createSignal<Record<string, InboxState>>({});
  const auth: Authenticator = {
    bindings: () => [binding],
    states: inbox,
    now: () => Date.parse("2026-10-24T07:15:00.000Z"),
    online: () => true,
    storageError: () => false,
    changed: noop,
    client: async () => {
      throw new Error("No network in this test");
    },
    stored: async () => undefined,
    account: async () => {
      throw new Error("No network in this test");
    },
    action: async () => {
      throw new Error("No action in this test");
    },
    act: noop,
    decideChange: noop,
    decide: noop,
    revoke: noop,
    syncPush: noop,
    forget: noop,
    rename: noop,
  };
  const preferences: Preferences = {
    locale: () => "de",
    language: () => "de",
    theme: () => "light",
    setLanguage: () => {},
    setTheme: () => {},
  };
  const dispose = render(() => createComponent(Clouds, { auth, preferences }), dom.root);
  try {
    await Bun.sleep(30);
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(dom.root.textContent).toContain("Checking for requests…");
    const request: Login = {
      requestId: "login",
      comparison: "623775",
      challenge: "unused",
      createdAt,
      expiresAt,
      context: decisionStates.known,
    };
    setInbox({ fixture: { requests: [request], actions: [], moreActions: 0, changes: [], moreChanges: 0 } });
    await Bun.sleep(30);
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")!;
    expect(dialog.querySelectorAll(".auth-decision__details[data-context] dd")).toHaveLength(6);
    expect(dialog.querySelector("[aria-busy='true'], .k2b-inline-guidance[data-loading]")).toBeNull();
  } finally {
    closeDialogs();
    await Bun.sleep(20);
    dispose();
    dom.cleanup();
  }
});
