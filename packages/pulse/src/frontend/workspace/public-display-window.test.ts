import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { openResolvedPublicDisplay } from "./public-display-window";

test("reserves and isolates the display before asynchronous link creation", async () => {
  const dom = createDomTestHarness();
  try {
    const order: string[] = [];
    const link = Promise.withResolvers<string>();
    const initialOpener: unknown = {};
    const display = {
      document: dom.document,
      opener: initialOpener,
      close: () => order.push("close"),
      location: {
        replace: (url: string) => {
          order.push(url);
        },
      },
    };
    const opening = openResolvedPublicDisplay(
      () => {
        expect(display.opener).toBeNull();
        expect(dom.document.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("no-referrer");
        order.push("resolve");
        return link.promise;
      },
      "Popup blocked",
      () => {
        order.push("reserve");
        return display;
      },
    );
    expect(order).toEqual(["reserve", "resolve"]);
    link.resolve("https://pulse.example/app/pulse/display/token");
    await opening;
    expect(order).toEqual(["reserve", "resolve", "https://pulse.example/app/pulse/display/token"]);
  } finally {
    dom.cleanup();
  }
});

test("blocked popup does not create a public link", async () => {
  let requested = false;
  await expect(
    openResolvedPublicDisplay(
      async () => {
        requested = true;
        return "/display/token";
      },
      "Allow pop-ups",
      () => null,
    ),
  ).rejects.toThrow("Allow pop-ups");
  expect(requested).toBe(false);
});

test("failed link creation closes the reserved tab and preserves the error", async () => {
  const dom = createDomTestHarness();
  try {
    let closed = false;
    let navigated = false;
    const failure = new Error("Refresh failed");
    await expect(
      openResolvedPublicDisplay(
        async () => {
          throw failure;
        },
        "Popup blocked",
        () => ({
          document: dom.document,
          opener: null,
          close: () => {
            closed = true;
          },
          location: {
            replace: () => {
              navigated = true;
            },
          },
        }),
      ),
    ).rejects.toBe(failure);
    expect(closed).toBe(true);
    expect(navigated).toBe(false);
  } finally {
    dom.cleanup();
  }
});
