import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../../ui/test/dom";
import {
  type GlobalSearchOptions,
  registerGlobalSearchHost,
  registerSearchNavigation,
  requestGlobalSearch,
  requestSearchNavigation,
} from "./search-bridge";

test("queues only the latest opening until a separately mounted host is ready", async () => {
  const dom = createDomTestHarness();
  try {
    const calls: GlobalSearchOptions[] = [];
    const first = requestGlobalSearch({ scope: { appId: "notebooks", label: "Notebooks" } });
    const second = requestGlobalSearch({ scope: { ref: { type: "spaces.space", id: "AaBb12" }, label: "Team" } });
    const stop = registerGlobalSearchHost((options) => calls.push(options));
    await Promise.all([first, second]);
    expect(calls).toEqual([{ scope: { ref: { type: "spaces.space", id: "AaBb12" }, label: "Team" } }]);
    await requestGlobalSearch({});
    expect(calls).toHaveLength(2);
    stop();
  } finally {
    dom.cleanup();
  }
});

test("host remount replaces the old listener; late old cleanup cannot unregister the new host", async () => {
  const dom = createDomTestHarness();
  try {
    const calls: string[] = [];
    let disposed = 0;
    const old = registerGlobalSearchHost(
      () => calls.push("old"),
      () => {
        disposed++;
      },
    );
    const current = registerGlobalSearchHost(() => calls.push("new"));
    old();
    await requestGlobalSearch({});
    expect(calls).toEqual(["new"]);
    expect(disposed).toBe(1);
    current();
  } finally {
    dom.cleanup();
  }
});

test("navigation waits for the handler and runs exactly once after remount", async () => {
  const dom = createDomTestHarness();
  try {
    const calls: string[] = [];
    const old = registerSearchNavigation(() => {
      calls.push("old");
      return false;
    });
    let finish!: (value: boolean) => void;
    const stop = registerSearchNavigation(({ href, ref }) => {
      calls.push(href);
      expect(ref?.id).toBe("AaBb12");
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    });
    old();
    const result = requestSearchNavigation({ href: "/notes/one", ref: { type: "notebooks.note", id: "AaBb12" } });
    await Promise.resolve();
    expect(calls).toEqual(["/notes/one"]);
    finish(true);
    expect(await result).toBe(true);
    stop();
    expect(await requestSearchNavigation({ href: "/tools/qr" })).toBe(false);
  } finally {
    dom.cleanup();
  }
});

test("unhandled navigation falls back, failures propagate without becoming an unhandled target", async () => {
  const dom = createDomTestHarness();
  try {
    const stop = registerSearchNavigation(() => false);
    expect(await requestSearchNavigation({ href: "/elsewhere" })).toBe(false);
    stop();
    const failed = registerSearchNavigation(() => {
      throw new Error("save failed");
    });
    await expect(requestSearchNavigation({ href: "/notes/one" })).rejects.toThrow("save failed");
    failed();
  } finally {
    dom.cleanup();
  }
});

test("unmount before dispatch completion prevents a stale fallback navigation", async () => {
  const dom = createDomTestHarness();
  try {
    let called = false;
    const stop = registerSearchNavigation(() => {
      called = true;
      return false;
    });
    const result = requestSearchNavigation({ href: "/notes/one" });
    stop();
    expect(await result).toBe(true);
    expect(called).toBe(false);
  } finally {
    dom.cleanup();
  }
});
