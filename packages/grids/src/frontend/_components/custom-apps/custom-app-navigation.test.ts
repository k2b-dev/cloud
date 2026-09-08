import { describe, expect, mock, test } from "bun:test";
import { createCustomAppNavigationGuard } from "./custom-app-navigation";

const currentUrl = "https://cloud.example/app/grids/BASE01/apps/APP001?edit=true";
const anchor = (href: string, target = "", download = false) => ({
  href,
  target,
  hasAttribute: (name: string) => name === "download" && download,
});
const click = (overrides: Partial<Parameters<ReturnType<typeof createCustomAppNavigationGuard>["click"]>[0]> = {}) => ({
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  preventDefault: mock(() => {}),
  ...overrides,
});

const setup = () => {
  let dirty = true;
  let complete: (saved: boolean) => void = () => {};
  const flush = mock(
    () =>
      new Promise<boolean>((resolve) => {
        complete = (saved) => {
          if (saved) dirty = false;
          resolve(saved);
        };
      }),
  );
  const navigate = mock((href: string) => {});
  const guard = createCustomAppNavigationGuard({ currentUrl: () => currentUrl, dirty: () => dirty, flush, navigate });
  return {
    guard,
    flush,
    navigate,
    complete: (saved: boolean) => complete(saved),
    setDirty: (value: boolean) => {
      dirty = value;
    },
  };
};

describe("Custom App draft navigation", () => {
  for (const destination of ["/app/grids/BASE01/table/TABLE01?edit=true", "/app/grids/BASE01/apps/APP001"]) {
    test(`flushes the pending draft before leaving for ${destination}`, async () => {
      const { guard, flush, navigate, complete } = setup();
      const event = click();
      const pending = guard.click(event, anchor(destination));
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(flush).toHaveBeenCalledTimes(1);
      expect(navigate).not.toHaveBeenCalled();
      complete(true);
      await pending;
      expect(navigate).toHaveBeenCalledWith(`https://cloud.example${destination}`);
    });
  }

  test("a failed flush keeps the editor open and allows a successful retry", async () => {
    const { guard, navigate, flush, complete } = setup();
    const first = guard.click(click(), anchor("/app/grids"));
    complete(false);
    await first;
    expect(navigate).not.toHaveBeenCalled();
    const retry = guard.click(click(), anchor("/app/grids"));
    expect(flush).toHaveBeenCalledTimes(2);
    complete(true);
    await retry;
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  test("repeated navigation clicks share the first pending flush", async () => {
    const { guard, navigate, flush, complete } = setup();
    const first = guard.click(click(), anchor("/app/grids"));
    const secondEvent = click();
    await guard.click(secondEvent, anchor("/app/dashboard"));
    expect(secondEvent.preventDefault).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    complete(true);
    await first;
    expect(navigate).toHaveBeenCalledWith("https://cloud.example/app/grids");
  });

  test("does not navigate if another edit remains dirty after flushing", async () => {
    const { guard, navigate, complete, setDirty } = setup();
    const pending = guard.click(click(), anchor("/app/grids"));
    complete(true);
    setDirty(true);
    await pending;
    expect(navigate).not.toHaveBeenCalled();
  });

  test("preserves modified clicks, downloads, external links and same-page hashes", async () => {
    const { guard, flush } = setup();
    for (const override of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
      { defaultPrevented: true },
    ]) {
      const event = click(override);
      await guard.click(event, anchor("/app/grids"));
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    for (const link of [
      anchor("/app/grids", "_blank"),
      anchor("/file", "", true),
      anchor("https://other.example"),
      anchor(`${currentUrl}#settings`),
      null,
    ]) {
      const event = click();
      await guard.click(event, link);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(flush).not.toHaveBeenCalled();
  });

  test("clean drafts use native navigation and do not prompt on unload", async () => {
    const { guard, flush, setDirty } = setup();
    setDirty(false);
    const event = click();
    await guard.click(event, anchor("/app/grids"));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
    const unload = { preventDefault: mock(() => {}), returnValue: "unchanged" };
    guard.beforeUnload(unload);
    expect(unload.preventDefault).not.toHaveBeenCalled();
    expect(unload.returnValue).toBe("unchanged");
  });

  test("dirty drafts request the native reload/close warning", () => {
    const { guard } = setup();
    const unload = { preventDefault: mock(() => {}), returnValue: "unchanged" };
    guard.beforeUnload(unload);
    expect(unload.preventDefault).toHaveBeenCalledTimes(1);
    expect(unload.returnValue).toBe("");
  });

  test("disposing the editor cancels delayed navigation", async () => {
    const { guard, navigate, complete } = setup();
    const pending = guard.click(click(), anchor("/app/grids"));
    guard.dispose();
    complete(true);
    await pending;
    expect(navigate).not.toHaveBeenCalled();
  });
});
