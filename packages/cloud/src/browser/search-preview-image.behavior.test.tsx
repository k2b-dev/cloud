import { describe, expect, jest, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { SearchItem } from "../api/search/schemas";

const waitFor = async (condition: () => boolean, label: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const file = (id: string): SearchItem => ({
  appId: "filesv2",
  appName: "Files",
  appIcon: "ti ti-folders",
  readable: true,
  ref: { type: "filesv2.entry", id },
  title: `${id}.jpg`,
  href: `/app/filesv2/ref/${id}`,
  preview: "Ankauf / Nachlass Albers",
});

/** The view Files' entry reader answers for an image (concept image 15): the picture from its own route, then the facts. */
const view = (id: string) => ({
  view: {
    version: 1,
    blocks: [
      { kind: "Image", src: `/api/filesv2/entries/${id}/image?rev=r1`, alt: `${id}.jpg`, ratio: 4 / 3 },
      { kind: "Detail", title: "Details", items: [{ label: "Size", value: "2.4 MB" }] },
    ],
  },
});

/**
 * A browser image request that is still under way: happy-dom loads no image and reports every one as complete. Its
 * element classes outlive one window, so the returned function puts the original back.
 */
const loading = (window: { HTMLImageElement: { prototype: object } }) => {
  const prototype = window.HTMLImageElement.prototype;
  const original = Object.getOwnPropertyDescriptor(prototype, "complete")!;
  Object.defineProperty(prototype, "complete", { configurable: true, get: () => false });
  return () => Object.defineProperty(prototype, "complete", original);
};

const searchFetch = (originalFetch: typeof fetch, previews: string[]) =>
  Object.assign(
    async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/search/preview") {
        previews.push(url.searchParams.get("id")!);
        return Response.json(view(url.searchParams.get("id")!));
      }
      return Response.json({
        query: "albers",
        count: 2,
        apps: [{ id: "filesv2", name: "Files", icon: "ti ti-folders" }],
        items: [file("vase"), file("teller")],
      });
    },
    { preconnect: originalFetch.preconnect },
  );

describe("search preview of an image file", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("shows the picture before the facts in a fixed place, tries a picture still being drawn twice more, then shows a labelled stand-in", async () => {
    const dom = createDomTestHarness();
    const loaded = loading(dom.window);
    const originalFetch = globalThis.fetch;
    const previews: string[] = [];
    globalThis.fetch = searchFetch(originalFetch, previews);
    const { default: Search } = await import("./CloudResourceSearch");
    delegateEvents(["input", "click", "keydown"]);
    const dispose = render(() => <Search initialAppId="filesv2" onClose={() => {}} onSelect={() => {}} />, dom.root);
    const figure = () => dom.root.querySelector<HTMLElement>(".cloud-blocks__image");
    const picture = () => figure()?.querySelector("img") ?? null;
    const waiting = () => figure()?.querySelector(".cloud-blocks__image-wait") ?? null;
    const standIn = () => figure()?.querySelector(".cloud-blocks__image-missing") ?? null;
    try {
      await waitFor(() => !!figure(), "the picture of the active hit");
      expect(previews).toEqual(["vase"]);
      // Loading: the picture already stands in its 4:3 place, before the facts, with the file name as its text.
      const cells = Array.from(dom.root.querySelectorAll(".cloud-blocks__cell")).map((cell) => cell.getAttribute("data-kind"));
      expect(cells).toEqual(["Image", "Detail"]);
      // The DOM writes the ratio as "<ratio> / 1"; the place is the 4:3 of the reader's view.
      const ratio = figure()!.style.aspectRatio;
      expect(ratio.replace(/ \/ 1$/, "")).toBe(String(4 / 3));
      expect(picture()!.getAttribute("src")).toBe("/api/filesv2/entries/vase/image?rev=r1");
      expect(picture()!.alt).toBe("vase.jpg");
      expect(standIn()).toBeNull();

      // A picture still being drawn (202) fails like a missing one: the muted place waits, then the route is asked again
      // under a fresh address, twice, 2 s apart.
      jest.useFakeTimers();
      try {
        for (const attempt of [1, 2]) {
          picture()!.dispatchEvent(new Event("error"));
          expect(picture()).toBeNull();
          expect(standIn()).toBeNull();
          expect(waiting()!.getAttribute("aria-label")).toBe("vase.jpg");
          expect(figure()!.style.aspectRatio).toBe(ratio);
          jest.advanceTimersByTime(1_999);
          expect(picture()).toBeNull();
          jest.advanceTimersByTime(1);
          expect(waiting()).toBeNull();
          expect(picture()!.getAttribute("src")).toBe(`/api/filesv2/entries/vase/image?rev=r1&retry=${attempt}`);
        }

        // Refused or missing: once the tries are spent, the same place keeps a labelled stand-in, and nothing waits.
        picture()!.dispatchEvent(new Event("error"));
        expect(waiting()).toBeNull();
        expect(standIn()!.getAttribute("role")).toBe("img");
        expect(standIn()!.getAttribute("aria-label")).toBe("vase.jpg");
        expect(figure()!.style.aspectRatio).toBe(ratio);
        expect(picture()).toBeNull();
        jest.advanceTimersByTime(10_000);
        expect(picture()).toBeNull();
      } finally {
        jest.useRealTimers();
      }

      // The next hit's picture is tried afresh: one failure does not hide another file's picture.
      const input = dom.root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      await waitFor(() => picture()?.getAttribute("src") === "/api/filesv2/entries/teller/image?rev=r1", "next picture");
      expect(standIn()).toBeNull();
      expect(previews).toEqual(["vase", "teller"]);
    } finally {
      dispose();
      loaded();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

  test("a picture that failed before its code ran counts as failed, and closing the preview ends a waiting try", async () => {
    // happy-dom's images are complete with no width, as a browser reports one that failed before hydration.
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = searchFetch(originalFetch, []);
    const { default: Search } = await import("./CloudResourceSearch");
    const figure = () => dom.root.querySelector<HTMLElement>(".cloud-blocks__image");
    jest.useFakeTimers();
    let dispose = () => {};
    try {
      dispose = render(() => <Search initialAppId="filesv2" onClose={() => {}} onSelect={() => {}} />, dom.root);
      // Fake timers hold Bun.sleep: the search's own short timers move on by hand, 10 ms a turn, until the picture stands.
      for (let turn = 0; turn < 100 && !figure(); turn += 1) {
        jest.advanceTimersByTime(10);
        await new Promise((done) => setImmediate(done));
      }
      // No error event arrives, yet the place already waits for its next try instead of keeping a broken image.
      expect(figure()!.querySelector("img")).toBeNull();
      expect(figure()!.querySelector(".cloud-blocks__image-wait")).not.toBeNull();
      expect(figure()!.querySelector(".cloud-blocks__image-missing")).toBeNull();
      const timers = jest.getTimerCount();
      expect(timers).toBeGreaterThan(0);
      dispose();
      expect(jest.getTimerCount()).toBe(timers - 1);
    } finally {
      jest.useRealTimers();
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});
