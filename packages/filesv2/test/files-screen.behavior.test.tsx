import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";
import type { BaseSummary, FileEntry } from "../src/contracts";
import type { WorkspaceSnapshot } from "../src/frontend/workspace-state";
import { current, entry, page } from "./history-fixtures";

/*
 * The detail of the v2 folder screen against the real API client shape: versions are numbered only for the file state
 * they belong to, and a folder's contents count only a complete page. Requests stay pending until a test answers them.
 */
type ApiRequest = { kind: string; input?: unknown; signal?: AbortSignal; settled?: boolean; resolve: (response: Response) => void };
const apiRequests: ApiRequest[] = [];
if (!isServer) {
  mock.module("@k2b/cloud/browser/search", () => ({ openGlobalSearch: () => {} }));
  const request = (kind: string) => (input?: unknown, options?: { init?: { signal?: AbortSignal } }) =>
    new Promise<Response>((resolve) => {
      const item: ApiRequest = {
        kind,
        input,
        signal: options?.init?.signal,
        resolve: (response) => {
          item.settled = true;
          resolve(response);
        },
      };
      apiRequests.push(item);
    });
  mock.module("../src/api/client", () => ({
    apiClient: {
      bases: {
        $get: request("bases"),
        ":baseId": {
          entries: { $get: request("entries") },
          search: { $get: request("search") },
          entry: { $get: request("entry") },
          favorite: { $post: request("favorite") },
          versions: {
            $get: request("versions"),
            restore: { $post: request("version-restore") },
            comment: { $post: request("version-comment") },
          },
        },
      },
      entries: { ":id": { $get: request("entry-by-id") } },
      activity: { $get: request("activity"), ":activityId": { recheck: { $post: request("recheck") } } },
      shares: { $get: request("shares"), ":shareId": { access: { $get: request("share-access") } } },
    },
  }));
}

const load = async () => {
  const dom = createDomTestHarness();
  try {
    return { FilesScreen: (await import("../src/frontend/FilesScreen.island")).default };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const pending = (kind: string) => {
  const found = [...apiRequests].reverse().find((request) => request.kind === kind && !request.settled);
  if (!found) throw new Error(`no pending ${kind} request; saw ${apiRequests.map((request) => request.kind).join(", ")}`);
  return found;
};
const answerIf = (kind: string, response: () => Response) => {
  const found = apiRequests.find((request) => request.kind === kind && !request.settled);
  found?.resolve(response());
};

// Fictional storage; the base ID has the canonical shape stable refs require.
const home: BaseSummary = {
  id: "cloud:groups:0b4c9a52-5f7e-4c47-9d2e-6c1f1f0a7b11",
  area: "cloud",
  kind: "groups",
  name: "Team Vertrieb",
  status: "existing",
  reason: null,
  indexEnabled: true,
  versioningEnabled: true,
  stableIds: true,
};
const NOW = "2026-10-20T12:30:00.000Z";
const snapshotOf = (patch: Partial<WorkspaceSnapshot> & Pick<WorkspaceSnapshot, "source">): WorkspaceSnapshot => ({
  bases: { items: [home], issues: [], editor: null },
  selectedId: home.id,
  directory: null,
  errorCode: null,
  now: NOW,
  ...patch,
});
const query = (request: ApiRequest) => (request.input as { query?: Record<string, string> } | undefined)?.query ?? {};
const versionFixtures = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `v-${index + 1}`,
    created: `2026-10-1${index + 1}T08:30:00.000Z`,
    size: index + 1,
    pinned: false,
    comment: null,
    author: null,
  }));

describe("the detail of the v2 folder screen", () => {
  if (isServer) {
    test.skip("requires the DOM runner", () => {});
    return;
  }
  let cleanup = () => {};
  beforeEach(() => setSystemTime(new Date(NOW)));
  afterEach(() => {
    cleanup();
    apiRequests.length = 0;
    setSystemTime();
  });
  const mount = (initial: WorkspaceSnapshot) => {
    const dom = createDomTestHarness();
    // v2 overlays read the phone query at once; the DOM harness has no global matchMedia, so a desktop answers.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: (media: string) => ({ media, matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    });
    dom.window.history.replaceState(null, "", initial.source);
    const dispose = render(() => createComponent(modules!.FilesScreen, { initial, timeZone: "Europe/Berlin" }), dom.root);
    cleanup = () => {
      dispose();
      dom.cleanup();
      if (descriptor) Object.defineProperty(globalThis, "matchMedia", descriptor);
      else Reflect.deleteProperty(globalThis, "matchMedia");
    };
    return dom;
  };
  const button = (root: ParentNode, label: string) =>
    [...root.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>("button, a")].find((element) => element.textContent?.trim() === label);
  /** The value of a fact of the detail, or undefined while it is not shown. */
  const fact = (root: ParentNode, label: string) =>
    [...root.querySelectorAll("dt")].find((term) => term.textContent?.trim() === label)?.nextElementSibling?.textContent?.trim();
  const sectionTitled = (root: ParentNode, title: string) =>
    [...root.querySelectorAll<HTMLElement>('[data-k2-part="Section"]')].find((section) => section.textContent?.includes(title));
  // The detail reads its file again after a version list; this answers that read with the state it found.
  const confirmEntry = (file: FileEntry) => {
    expect(pending("entry").input).toEqual({ param: { baseId: home.id }, query: { path: file.path } });
    pending("entry").resolve(Response.json({ base: home, entry: file }));
  };

  for (const change of ["revision", "size", "identity"] as const)
    for (const refresh of ["current", "unchanged", "failed"] as const)
      test(`details of R3 never number or restore from the version list of R4 (${change}, ${refresh} details refresh)`, async () => {
        const file: FileEntry = {
          name: "Proof.bin",
          path: "Kunden/Proof.bin",
          directory: false,
          size: 1,
          modified: NOW,
          ...(change === "size" ? {} : { revision: "rev-3" }),
          ...(change === "identity" ? { resourceId: "original-file" } : {}),
        };
        const newer: FileEntry =
          change === "size"
            ? { ...file, size: 2 }
            : change === "identity"
              ? { ...file, resourceId: "replacement-file" }
              : { ...file, size: 2, modified: "2026-10-20T12:31:00.000Z", revision: "rev-4" };
        const raw = current(file.path, { directory: false });
        if (raw.visibility !== "full") throw new Error("fixture side must be full");
        const request = { baseId: home.id, path: file.path, scope: "item" as const };
        const dom = mount(
          snapshotOf({
            source: `/app/filesv2?base=${encodeURIComponent(home.id)}&path=Kunden&file=${encodeURIComponent(file.path)}`,
            directory: { base: home, path: "Kunden", items: [file], next: null },
            detail: { base: home, entry: file },
            history: {
              source: JSON.stringify(request),
              page: page([
                entry({ action: "file.overwrite", after: { ...raw, revision: change === "identity" ? "older-revision" : "rev-3" } }),
              ]),
            },
          }),
        );
        const detail = () => dom.root;
        const section = () => dom.root.querySelector<HTMLElement>(".filesv2-inspector-versions")!;
        const titles = () => [...section().querySelectorAll(".k2b-detail-panel__action-title")].map((title) => title.textContent?.trim());
        await flush();
        answerIf("shares", () => Response.json({ items: [], next: null }));
        // R4 was written after the details were read: the list now saves R3 as v-3.
        pending("versions").resolve(Response.json(versionFixtures(3)));
        await flush();
        confirmEntry(newer);
        await flush();
        expect(detail().textContent).not.toContain("Version 4");
        expect(button(detail(), "Restore version 3")).toBeUndefined();
        // No count for a list that is not confirmed for this file state.
        expect(fact(detail(), "Versions")).toBeUndefined();
        // Exactly one details refresh follows the mismatched list.
        expect(apiRequests.filter((item) => item.kind === "entry")).toHaveLength(2);
        if (refresh === "failed") {
          pending("entry").resolve(Response.json({ message: "Unavailable" }, { status: 503 }));
          await flush();
          // The failed refresh ends in the detail's Failed with its retry, not in a spinner.
          expect(detail().textContent).toContain("This item is no longer available or you do not have access.");
          expect(detail().textContent).not.toContain("Version 4");
          detail().querySelector<HTMLButtonElement>(`[data-k2-part="Failed"] button`)!.click();
          await flush();
        } else if (refresh === "unchanged") {
          pending("entry").resolve(Response.json({ base: home, entry: file }));
          await flush();
          // Still no confirmation: a failed list with Try again, never an endless spinner or a guessed number.
          expect(section().textContent).toContain("Versions not loaded.");
          expect(fact(detail(), "Versions")).toBeUndefined();
          expect(detail().textContent).not.toContain("Version 4");
          expect(apiRequests.filter((item) => item.kind === "entry")).toHaveLength(2);
          button(section(), "Try again")!.click();
          await flush();
          pending("versions").resolve(Response.json(versionFixtures(3)));
          await flush();
          confirmEntry(newer);
          await flush();
          // A new mismatched list asks the details once more.
          expect(apiRequests.filter((item) => item.kind === "entry")).toHaveLength(4);
        }
        pending("entry").resolve(Response.json({ base: home, entry: newer }));
        await flush();
        // The details show R4, so its list is read and confirmed again.
        pending("versions").resolve(Response.json(versionFixtures(3)));
        await flush();
        confirmEntry(newer);
        await flush();
        expect(titles()[0]).toBe("Version 4 · current");
        expect(fact(detail(), "Versions")).toBe("4");
        // The overwrite that produced R3 no longer names the current file, so it restores no predecessor.
        expect(button(detail(), "Restore version 3")).toBeUndefined();
        expect(button(detail(), "Restore version 2")).toBeUndefined();
        expect(apiRequests.some((item) => item.kind === "version-restore")).toBe(false);
      });

  for (const next of [null, "more-children"])
    test(`folder contents retry a failed read and ${next ? "claim no total for an incomplete page" : "count a complete page exactly"}`, async () => {
      const folder: FileEntry = { name: "Druckdaten", path: "Druckdaten", directory: true, size: 0, modified: NOW };
      const first: FileEntry = { name: "Proof.pdf", path: "Druckdaten/Proof.pdf", directory: false, size: 2, modified: NOW };
      const readme: FileEntry = { name: "README.md", path: "Druckdaten/README.md", directory: false, size: 3, modified: NOW };
      const request = { baseId: home.id, path: folder.path, scope: "folder" as const };
      const dom = mount(
        snapshotOf({
          source: `/app/filesv2?base=${encodeURIComponent(home.id)}&file=Druckdaten`,
          directory: { base: home, path: "", items: [folder], next: null },
          detail: { base: home, entry: folder },
          history: { source: JSON.stringify(request), page: page([]) },
        }),
      );
      await flush();
      const contents = () => sectionTitled(dom.root, "Contents")!;
      const count = () => contents().querySelector(".k2-sh-count");
      expect(contents().querySelector('[data-k2-part="Loading"]')).not.toBeNull();
      expect(count()).toBeNull();
      expect(query(pending("entries"))).toEqual({ path: folder.path });
      pending("entries").resolve(Response.json({ message: "Unavailable" }, { status: 503 }));
      await flush();
      expect(contents().querySelector('[data-k2-part="Failed"]')?.textContent).toContain(
        "The contents of this folder cannot be loaded right now. The folder itself is up to date.",
      );
      expect(count()).toBeNull();
      contents().querySelector<HTMLButtonElement>(`[data-k2-part="Failed"] button`)!.click();
      await flush();
      expect(contents().querySelector('[data-k2-part="Loading"]')).not.toBeNull();
      pending("entries").resolve(Response.json({ base: home, path: folder.path, items: [first, readme], readme, next }));
      await flush();
      // Only a complete page supplies a total; no child-page cursor is followed and the folder reads no versions.
      if (next) expect(count()).toBeNull();
      else expect(count()?.textContent).toBe("2");
      expect([...contents().querySelectorAll('[data-k2-part="Row"]')].map((row) => row.textContent)).toEqual([
        expect.stringContaining(first.name),
        expect.stringContaining(readme.name),
      ]);
      expect(apiRequests.filter((item) => item.kind === "entries")).toHaveLength(2);
      expect(apiRequests.some((item) => item.kind === "versions")).toBe(false);
    });
});
