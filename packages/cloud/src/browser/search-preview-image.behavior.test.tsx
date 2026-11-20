import { describe, expect, test } from "bun:test";
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

describe("search preview of an image file", () => {
  if (isServer) {
    test.skip("runs with browser export conditions", () => {});
    return;
  }

  test("shows the picture before the facts in a fixed place while it loads, and a labelled stand-in when it fails", async () => {
    const dom = createDomTestHarness();
    const originalFetch = globalThis.fetch;
    const previews: string[] = [];
    globalThis.fetch = Object.assign(
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
    const { default: Search } = await import("./CloudResourceSearch");
    delegateEvents(["input", "click", "keydown"]);
    const dispose = render(() => <Search initialAppId="filesv2" onClose={() => {}} onSelect={() => {}} />, dom.root);
    const figure = () => dom.root.querySelector<HTMLElement>(".cloud-blocks__image");
    try {
      await waitFor(() => !!figure(), "the picture of the active hit");
      expect(previews).toEqual(["vase"]);
      // Loading: the picture already stands in its 4:3 place, before the facts, with the file name as its text.
      const cells = Array.from(dom.root.querySelectorAll(".cloud-blocks__cell")).map((cell) => cell.getAttribute("data-kind"));
      expect(cells).toEqual(["Image", "Detail"]);
      // The DOM writes the ratio as "<ratio> / 1"; the place is the 4:3 of the reader's view.
      const ratio = figure()!.style.aspectRatio;
      expect(ratio.replace(/ \/ 1$/, "")).toBe(String(4 / 3));
      const picture = figure()!.querySelector("img")!;
      expect(picture.getAttribute("src")).toBe("/api/filesv2/entries/vase/image?rev=r1");
      expect(picture.alt).toBe("vase.jpg");
      expect(dom.root.querySelector(".cloud-blocks__image-missing")).toBeNull();

      // Refused or missing: the same place keeps a labelled stand-in instead of a broken image.
      picture.dispatchEvent(new Event("error"));
      await waitFor(() => !!dom.root.querySelector(".cloud-blocks__image-missing"), "the stand-in");
      const standIn = dom.root.querySelector(".cloud-blocks__image-missing")!;
      expect(standIn.closest(".cloud-blocks__image")).toBe(figure());
      expect(figure()!.style.aspectRatio).toBe(ratio);
      expect(standIn.getAttribute("role")).toBe("img");
      expect(standIn.getAttribute("aria-label")).toBe("vase.jpg");
      expect(figure()!.querySelector("img")).toBeNull();

      // The next hit's picture is tried afresh: one failure does not hide another file's picture.
      const input = dom.root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      await waitFor(
        () => figure()?.querySelector("img")?.getAttribute("src") === "/api/filesv2/entries/teller/image?rev=r1",
        "next picture",
      );
      expect(dom.root.querySelector(".cloud-blocks__image-missing")).toBeNull();
      expect(previews).toEqual(["vase", "teller"]);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });
});
