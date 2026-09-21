import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires DOM conditions", () => {});
else
  test("CSV preferences decode original bytes, survive remount and expose an adjustments dialog", async () => {
    const dom = createDomTestHarness();
    const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
    const { default: FileView } = await import("../src/content/FileView");
    const bytes = Uint8Array.from([110, 97, 109, 101, 59, 118, 97, 108, 117, 101, 10, 83, 252, 100, 59, 52, 50]);
    const encoded = btoa(String.fromCharCode(...bytes));
    dom.window.localStorage.setItem("csv-test", JSON.stringify({ encoding: "windows-1252", delimiter: ";", view: "table" }));
    const mount = () =>
      render(
        () =>
          createComponent(FileView, {
            file: { path: "/sample.csv", size: bytes.length, mediaType: "text/csv" },
            previewPreferencesKey: "csv-test",
            load: async () => ({ encoding: "base64", content: encoded, mediaType: "text/csv" }),
          }),
        dom.root,
      );
    let dispose = mount();
    try {
      await Bun.sleep(30);
      expect(dom.root.querySelectorAll("th")).toHaveLength(2);
      expect(dom.root.textContent).toContain("Süd");
      const settings =
        dom.root.querySelector<HTMLButtonElement>('button[title="CSV display settings"]') ??
        Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
          button.innerHTML.includes("ti-adjustments-horizontal"),
        );
      expect(settings).toBeDefined();
      settings!.click();
      await Bun.sleep(30);
      expect(dom.document.querySelector("dialog")).not.toBeNull();
      expect(dom.document.querySelectorAll('[role="combobox"]')).toHaveLength(3);
      dom.document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
      dispose();
      dom.window.localStorage.setItem("csv-test", JSON.stringify({ encoding: "windows-1252", delimiter: ";", view: "raw" }));
      dispose = mount();
      await Bun.sleep(30);
      expect(dom.root.querySelector("table")).toBeNull();
      expect(dom.root.textContent).toContain("Süd;42");
      expect(encoded).toBe(btoa(String.fromCharCode(...bytes)));
    } finally {
      dispose();
      if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
      dom.cleanup();
    }
  });

if (!isServer)
  test("compact CSV counts hidden records and full preview pages through every row", async () => {
    const dom = createDomTestHarness();
    const { default: FileView } = await import("../src/content/FileView");
    const content = "name,note\n" + Array.from({ length: 205 }, (_, i) => `${i},"two\nlines"`).join("\n");
    let expanded = false;
    const mount = (previewLines?: number) =>
      render(
        () =>
          createComponent(FileView, {
            file: { path: "test.csv" },
            previewLines,
            onExpandPreview: () => {
              expanded = true;
            },
            load: async () => ({ encoding: "utf8", content, mediaType: "text/csv" }),
          }),
        dom.root,
      );
    let dispose = mount(5);
    try {
      await Bun.sleep(30);
      expect(dom.root.querySelectorAll("tbody tr")).toHaveLength(5);
      const more = Array.from(dom.root.querySelectorAll("button")).find((b) => b.textContent?.includes("200 more lines"));
      expect(more).toBeDefined();
      more!.click();
      expect(expanded).toBe(true);
      dispose();
      dispose = mount();
      await Bun.sleep(30);
      expect(dom.root.querySelectorAll("tbody tr")).toHaveLength(200);
      Array.from(dom.root.querySelectorAll("button"))
        .find((b) => b.textContent === "Next")!
        .click();
      expect(dom.root.querySelectorAll("tbody tr")).toHaveLength(5);
      expect(dom.root.querySelector("tbody td")?.textContent).toBe("200");
    } finally {
      dispose();
      dom.cleanup();
    }
  });

if (!isServer)
  test("compact Markdown keeps its heading scale and expands without modifying the source", async () => {
    const dom = createDomTestHarness();
    const { default: FileView } = await import("../src/content/FileView");
    const content = "# Title\n\none\ntwo\nthree\nfour\nfive";
    const mount = (previewLines?: number) =>
      render(
        () =>
          createComponent(FileView, {
            file: { path: "README.md" },
            previewLines,
            headingScale: previewLines ? "compact" : "normal",
            load: async () => ({ encoding: "utf8", content, mediaType: "text/markdown" }),
          }),
        dom.root,
      );
    let dispose = mount(5);
    try {
      await Bun.sleep(30);
      expect(dom.root.textContent).toContain("2 more lines");
      expect(dom.root.textContent).not.toContain("five");
      expect(dom.root.querySelector('[data-heading-scale="compact"]')).not.toBeNull();
      dispose();
      dispose = mount();
      await Bun.sleep(30);
      expect(dom.root.textContent).toContain("five");
      expect(dom.root.querySelector('[data-heading-scale="compact"]')).toBeNull();
    } finally {
      dispose();
      dom.cleanup();
    }
  });
