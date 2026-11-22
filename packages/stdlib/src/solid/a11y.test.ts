import { describe, it, expect, mock } from "bun:test";
import { a11y } from "./a11y";

describe("a11y.clickOrEnter", () => {
  it("onClick calls fn with event and stops propagation", () => {
    const fn = mock(() => {});
    const handlers = a11y.clickOrEnter(fn);
    const event = {
      stopPropagation: mock(() => {}),
    } as unknown as MouseEvent;

    handlers.onClick(event as never);
    expect(fn).toHaveBeenCalledTimes(1);
    expect((event.stopPropagation as any).mock.calls.length).toBe(1);
  });

  it("onKeyDown calls fn on Enter key", () => {
    const fn = mock(() => {});
    const handlers = a11y.clickOrEnter(fn);
    const event = {
      key: "Enter",
      preventDefault: mock(() => {}),
      stopPropagation: mock(() => {}),
    } as unknown as KeyboardEvent;

    handlers.onKeyDown(event as never);
    expect(fn).toHaveBeenCalledTimes(1);
    expect((event.preventDefault as any).mock.calls.length).toBe(1);
  });

  it("onKeyDown calls fn on Space key", () => {
    const fn = mock(() => {});
    const handlers = a11y.clickOrEnter(fn);
    const event = {
      key: " ",
      preventDefault: mock(() => {}),
      stopPropagation: mock(() => {}),
    } as unknown as KeyboardEvent;

    handlers.onKeyDown(event as never);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("onKeyDown does NOT call fn on other keys", () => {
    const fn = mock(() => {});
    const handlers = a11y.clickOrEnter(fn);
    const event = {
      key: "a",
      preventDefault: mock(() => {}),
      stopPropagation: mock(() => {}),
    } as unknown as KeyboardEvent;

    handlers.onKeyDown(event as never);
    expect(fn).toHaveBeenCalledTimes(0);
  });

  it("onKeyDown prevents default on Enter/Space", () => {
    const fn = mock(() => {});
    const handlers = a11y.clickOrEnter(fn);

    for (const key of ["Enter", " "]) {
      const event = {
        key,
        preventDefault: mock(() => {}),
        stopPropagation: mock(() => {}),
      } as unknown as KeyboardEvent;
      handlers.onKeyDown(event as never);
      expect((event.preventDefault as any).mock.calls.length).toBe(1);
    }
  });
});

