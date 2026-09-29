import { describe, expect, test } from "bun:test";
import { createEffect } from "solid-js";
import { isServer, render } from "solid-js/web";
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
  icalToken: "calendar-token",
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
    // The running deletion shows on the button itself, busy for assistive technology too.
    const button = dom.root.querySelector<HTMLButtonElement>("button")!;
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent?.trim()).toBe("Deleting");

    dispose();
    expect(requestSignal.aborted).toBeTrue();
    expect(pending.at(-1)).toBeFalse();

    response.resolve(new Response(null, { status: 204 }));
    prompts.confirm = originalConfirm;
    globalThis.fetch = originalFetch;
    dom.cleanup();
  });
});
