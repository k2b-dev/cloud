import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import type { AccessEntry } from "@k2b/cloud/contracts";
import { createEffect } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { Venue, VenueDashboard } from "../src/contracts";
import {
  createVenueSettingsQuery,
  reconcileChangedSettings,
  settingsCloseBlocked,
  settingsInteractionBlocked,
} from "../src/frontend/settings-contract";

const flush = async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const venue: Venue = {
  id: "venue-1",
  slug: "student-cafe",
  name: "Student cafe",
  icon: "ti ti-building",
  description: null,
  timezone: "Europe/Berlin",
  openMode: "combined",
  signupMode: "both",
  publicEnabled: true,
  feedbackEnabled: false,
  accentColor: "#2563eb",
  logoBase64: null,
  bannerBase64: null,
  permission: "admin",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
};

const dashboard: VenueDashboard = {
  venue,
  openingRules: [],
  overrides: [],
  templates: [],
  slots: [],
  otherAssignments: [],
  outlook: { startDate: "2026-09-28", endDate: "2026-10-04", missingPeople: 0, nextGap: null },
  assignments: [],
  myUpcomingShifts: [],
  myShiftCount: 0,
  sections: [],
  feedback: { count: 0, averageRating: null, commentCount: 0, buckets: [] },
  feedbackEntries: [],
  feedbackEntriesPage: { page: 1, pageSize: 50, total: 0 },
};

describe("Venue settings lifecycle behavior", () => {
  test("blocks coordinated interactions for every owned write and coverage phase", () => {
    const base = {
      prompting: false,
      writePending: false,
      reconciling: false,
      coverageError: false,
      childPending: false,
      requestCount: 0,
      mutationPending: false,
    };
    expect(settingsInteractionBlocked({ ...base, prompting: true })).toBeTrue();
    expect(settingsInteractionBlocked({ ...base, writePending: true })).toBeTrue();
    expect(settingsInteractionBlocked({ ...base, reconciling: true })).toBeTrue();
    expect(settingsInteractionBlocked({ ...base, coverageError: true })).toBeTrue();
    expect(settingsInteractionBlocked({ ...base, childPending: true })).toBeTrue();
    expect(settingsInteractionBlocked({ ...base, requestCount: 1 })).toBeTrue();
    expect(settingsInteractionBlocked({ ...base, mutationPending: true })).toBeTrue();
    expect(settingsInteractionBlocked(base)).toBeFalse();
  });

  test("allows closing with an honest result after a read or coverage error", () => {
    const base = {
      prompting: false,
      writePending: false,
      reconciling: false,
      coverageError: false,
      childPending: false,
      requestCount: 0,
      mutationPending: false,
    };
    expect(settingsCloseBlocked({ ...base, coverageError: true })).toBeFalse();
    expect(settingsCloseBlocked({ ...base, writePending: true })).toBeTrue();
    expect(settingsCloseBlocked({ ...base, reconciling: true })).toBeTrue();
  });

  test("reconciles a changed settings result with its parent exactly once", async () => {
    let reconciliations = 0;
    const reconcile = async () => {
      reconciliations += 1;
    };

    await expect(reconcileChangedSettings(false, reconcile)).resolves.toBeFalse();
    await expect(reconcileChangedSettings(true, reconcile)).resolves.toBeTrue();
    expect(reconciliations).toBe(1);
  });

  if (isServer) {
    test.skip("fresh reopen runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("refreshes every open, so a fresh read replaces a stale seed", async () => {
    const dom = createDomTestHarness();
    const responses = ["admin", "read"] as const;
    let reads = 0;

    const mountSettings = () =>
      render(() => {
        const settings = createVenueSettingsQuery<{ venue: { permission: "read" | "admin" } }>({
          venueId: "venue-1",
          initial: { venue: { permission: "admin" } },
          load: async () => ({ venue: { permission: responses[reads++]! } }),
        });
        const output = dom.document.createElement("output");
        createEffect(() => {
          const current = settings.data();
          output.textContent = current?.venue.permission ?? "";
        });
        return output;
      }, dom.root);

    const firstDispose = mountSettings();
    await flush();
    expect(dom.root.textContent).toBe("admin");
    firstDispose();
    dom.root.replaceChildren();

    const reopenedDispose = mountSettings();
    await flush();
    expect(reads).toBe(2);
    expect(dom.root.textContent).toBe("read");

    reopenedDispose();
    dom.cleanup();
  });

  test("keeps the full general form read-only until the fresh settings payload is applied", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const response = deferred<Response>();
    globalThis.fetch = (() => response.promise) as typeof fetch;

    const { SettingsDialog } = await import("../src/frontend/_components/venue-workspace/settings.tsx");
    const dispose = render(
      () =>
        SettingsDialog({
          dashboard,
          accessEntries: [],
          apiKeys: [],
          close: () => {},
        }),
      dom.root,
    );

    expect(dom.root.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBeTrue();
    response.resolve(
      Response.json({
        venue: { ...venue, name: "Fresh venue" },
        openingRules: [],
        overrides: [],
        templates: [],
        accessEntries: [],
        apiKeys: [],
      }),
    );
    await flush();
    expect(dom.root.querySelector<HTMLFieldSetElement>("fieldset")?.disabled).toBeFalse();
    expect(dom.root.querySelector<HTMLInputElement>("input")?.value).toBe("Fresh venue");

    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  });

  test("access changes save in the access dialog, keep the settings open meanwhile, and reload them once", async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    const originalFetch = globalThis.fetch;
    const reload = deferred<Response>();
    let reads = 0;
    const writes: string[] = [];
    let closed: boolean | undefined;
    const owner: AccessEntry = {
      id: "access-0",
      principal: { type: "user", userId: "mia" },
      displayName: "Mia Hoffmann",
      permission: "admin",
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    let saved: AccessEntry = {
      id: "access-1",
      principal: { type: "user", userId: "ada" },
      displayName: "Ada Lovelace",
      permission: "read",
      createdAt: "2026-08-11T00:00:00.000Z",
    };
    const payload = () => ({ venue, openingRules: [], overrides: [], templates: [], accessEntries: [owner, saved], apiKeys: [] });
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          writes.push(String(input));
          saved = { ...saved, permission: "write" };
          return new Response(null, { status: 204 });
        }
        reads += 1;
        return reads === 1 ? Response.json(payload()) : reload.promise;
      },
      { preconnect: originalFetch.preconnect },
    );
    setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
    const { SettingsDialog } = await import("../src/frontend/_components/venue-workspace/settings.tsx");
    delegateEvents(["click", "input"], dom.document);
    const dispose = render(
      () =>
        SettingsDialog({
          dashboard,
          accessEntries: [owner, saved],
          apiKeys: [],
          initialTab: "access",
          close: (changed) => {
            closed = changed;
          },
        }),
      dom.root,
    );
    const button = (text: string) =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text);
    const accessDialog = () => dom.document.querySelector<HTMLElement>('[role="dialog"]');
    const waitFor = async (condition: () => boolean, label: string) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (condition()) return;
        await Bun.sleep(10);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    try {
      await waitFor(() => reads === 1 && !!button("Edit access"), "the settings");
      await flush();
      button("Edit access")!.click();
      await waitFor(() => accessDialog()?.textContent?.includes("Ada Lovelace") === true, "the access dialog");
      // The settings stay open while the access dialog is.
      dom.root.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!.click();
      expect(closed).toBeUndefined();
      const row = Array.from(accessDialog()!.querySelectorAll("li")).find((item) => item.textContent?.includes("Ada Lovelace"))!;
      Array.from(row.querySelectorAll<HTMLElement>('[role="option"]'))
        .find((option) => option.textContent?.includes("Staff"))!
        .click();
      await waitFor(() => accessDialog()?.textContent?.includes("1 change") === true, "one change");
      expect(writes).toEqual([]);
      button("Save")!.click();
      await waitFor(() => !accessDialog() && reads === 2, "the save and its reload");
      expect(writes).toHaveLength(1);
      reload.resolve(Response.json(payload()));
      await waitFor(() => dom.root.textContent?.includes("Staff") === true, "the list to show the saved level");
      expect(reads).toBe(2);
      // Once the reload finished, closing reports the change, so the workspace reloads.
      await waitFor(() => {
        dom.root.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!.click();
        return closed !== undefined;
      }, "the settings to close");
      expect(closed).toBe(true);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      setSystemTime();
      dom.cleanup();
    }
  });

  test("a half-failed, discarded access save still reloads the settings, and a failed reload hides editing until it is read", async () => {
    const dom = createDomTestHarness();
    dom.document.documentElement.lang = "en";
    const originalFetch = globalThis.fetch;
    let reads = 0;
    const writes: string[] = [];
    let closed: boolean | undefined;
    const person = (id: string, name: string, permission: AccessEntry["permission"]): AccessEntry => ({
      id,
      principal: { type: "user", userId: id },
      displayName: name,
      permission,
      createdAt: "2026-08-11T00:00:00.000Z",
    });
    const entries = [person("mia", "Mia Hoffmann", "admin"), person("ada", "Ada Lovelace", "read"), person("bob", "Bob Marley", "read")];
    const payload = () => ({ venue, openingRules: [], overrides: [], templates: [], accessEntries: entries, apiKeys: [] });
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "PATCH" || init?.method === "DELETE") {
          writes.push(`${init.method} ${String(input).split("/access/")[1]}`);
          return init.method === "PATCH" ? new Response(null, { status: 204 }) : Response.json({ message: "offline" }, { status: 503 });
        }
        reads += 1;
        return reads === 1 ? Response.json(payload()) : Response.json({ message: "offline" }, { status: 503 });
      },
      { preconnect: originalFetch.preconnect },
    );
    setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
    const { prompts } = await import("@k2b/ui");
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const error = spyOn(prompts, "error").mockResolvedValue(undefined);
    const { SettingsDialog } = await import("../src/frontend/_components/venue-workspace/settings.tsx");
    delegateEvents(["click", "input"], dom.document);
    const dispose = render(
      () =>
        SettingsDialog({
          dashboard,
          accessEntries: entries,
          apiKeys: [],
          initialTab: "access",
          close: (changed) => {
            closed = changed;
          },
        }),
      dom.root,
    );
    const button = (text: string) =>
      Array.from(dom.document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text);
    const accessDialog = () => dom.document.querySelector<HTMLElement>('[role="dialog"]');
    const row = (name: string) => Array.from(accessDialog()!.querySelectorAll("li")).find((item) => item.textContent?.includes(name))!;
    const waitFor = async (condition: () => boolean, label: string) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (condition()) return;
        await Bun.sleep(10);
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    try {
      await waitFor(() => reads === 1 && !!button("Edit access"), "the settings");
      await flush();
      button("Edit access")!.click();
      await waitFor(() => accessDialog()?.textContent?.includes("Bob Marley") === true, "the access dialog");
      Array.from(row("Ada Lovelace").querySelectorAll<HTMLElement>('[role="option"]'))
        .find((option) => option.textContent?.includes("Staff"))!
        .click();
      row("Bob Marley").querySelector<HTMLButtonElement>('button[aria-label="Remove Bob Marley"]')!.click();
      await waitFor(() => accessDialog()?.textContent?.includes("2 changes") === true, "two changes");
      button("Save")!.click();
      await waitFor(() => !!accessDialog()?.querySelector('[role="alert"]'), "the failed removal");
      expect(writes).toEqual(["PATCH ada", "DELETE bob"]);
      button("Cancel")!.click();
      await waitFor(() => !accessDialog() && reads === 2, "one reload after the dialog");
      // The reload failed: the saved change is reported, and editing waits until the settings are read again.
      await waitFor(() => error.mock.calls.length === 1, "the reload failure");
      await waitFor(() => !button("Edit access"), "editing to wait for a fresh read");
      await waitFor(() => {
        dom.root.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')!.click();
        return closed !== undefined;
      }, "the settings to close");
      expect(closed).toBe(true);
    } finally {
      dispose();
      confirm.mockRestore();
      error.mockRestore();
      globalThis.fetch = originalFetch;
      setSystemTime();
      dom.cleanup();
    }
  });

  test("allows closing after the initial settings read fails", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    let closeResult: boolean | undefined;
    globalThis.fetch = (async () => Response.json({ message: "offline" }, { status: 503 })) as typeof fetch;

    const { SettingsDialog } = await import("../src/frontend/_components/venue-workspace/settings.tsx");
    const dispose = render(
      () =>
        SettingsDialog({
          dashboard,
          accessEntries: [],
          apiKeys: [],
          close: (changed) => {
            closeResult = changed;
          },
        }),
      dom.root,
    );
    await flush();
    dom.root.querySelector<HTMLButtonElement>('[aria-label="Close settings"]')?.click();
    expect(closeResult).toBeFalse();

    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  });

  test("propagates danger confirmation and request ownership to the settings blocker", async () => {
    const dom = createDomTestHarness();
    const { prompts } = await import("@k2b/ui");
    const originalConfirm = prompts.confirm;
    const originalFetch = globalThis.fetch;
    const confirmation = deferred<boolean>();
    const response = deferred<Response>();
    let requestSignal!: AbortSignal;
    const pending: boolean[] = [];
    prompts.confirm = (() => confirmation.promise) as typeof prompts.confirm;
    globalThis.fetch = ((_input, init) => {
      requestSignal = init?.signal as AbortSignal;
      return response.promise;
    }) as typeof fetch;

    const { VenueDangerZone } = await import("../src/frontend/_components/venue-workspace/settings.tsx");
    const dispose = render(
      () =>
        VenueDangerZone({
          venue,
          onPendingChange: (value) => pending.push(value),
        }),
      dom.root,
    );

    dom.root.querySelector<HTMLButtonElement>("button")!.click();
    expect(pending.at(-1)).toBeTrue();
    confirmation.resolve(true);
    await flush();
    expect(pending.at(-1)).toBeTrue();
    expect(requestSignal.aborted).toBeFalse();
    // The running deletion shows on the button itself, busy for assistive technology too:
    // a spinner over the idle label, which keeps the width, and the loading label as its name.
    const button = dom.root.querySelector<HTMLButtonElement>("button")!;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Deleting");
    expect(button.textContent?.trim()).toBe("Delete venue");

    dispose();
    expect(requestSignal.aborted).toBeTrue();
    expect(pending.at(-1)).toBeFalse();

    response.resolve(new Response(null, { status: 204 }));
    prompts.confirm = originalConfirm;
    globalThis.fetch = originalFetch;
    dom.cleanup();
  });
});
