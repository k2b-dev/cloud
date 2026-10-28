import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDomTestHarness } from "../../../ui/test/dom";
import { pwaDrafts } from "./pwa-drafts";

let dom: ReturnType<typeof createDomTestHarness>;
beforeEach(() => {
  dom = createDomTestHarness();
});
afterEach(() => {
  pwaDrafts.clearAll();
  dom.cleanup();
});

test("stores only typed text, keeps empty drafts, and isolates account and field ids", () => {
  expect(pwaDrafts.write("a", "chat", "hello\nthere")).toBe(true);
  pwaDrafts.write("b", "chat", "other account");
  pwaDrafts.write("a", "settings", "");
  expect(dom.window.localStorage.getItem("cloud.pwa.draft:a:chat")).toBe("hello\nthere");
  expect(pwaDrafts.read("a", "chat")).toBe("hello\nthere");
  expect(pwaDrafts.read("b", "chat")).toBe("other account");
  expect(pwaDrafts.read("a", "settings")).toBe("");
  expect(pwaDrafts.has("a")).toBe(true);
  expect(pwaDrafts.has("c")).toBe(false);
  pwaDrafts.write("a:b", "c", "first");
  pwaDrafts.write("a", "b:c", "second");
  expect(pwaDrafts.read("a:b", "c")).toBe("first");
});

test("restores from storage and removes one saved draft without touching another", () => {
  dom.window.localStorage.setItem("cloud.pwa.draft:a:chat", "from a previous process");
  expect(pwaDrafts.read("a", "chat")).toBe("from a previous process");
  pwaDrafts.write("b", "chat", "keep");
  pwaDrafts.remove("a", "chat");
  expect(pwaDrafts.read("a", "chat")).toBeUndefined();
  expect(pwaDrafts.has("a")).toBe(false);
  expect(pwaDrafts.read("b", "chat")).toBe("keep");
});

test("sign-out clears all app drafts and leaves unrelated localStorage alone", () => {
  pwaDrafts.write("a", "chat", "one");
  pwaDrafts.write("b", "name", "two");
  dom.window.localStorage.setItem("other", "keep");
  pwaDrafts.clearAll();
  expect(dom.window.localStorage.length).toBe(1);
  expect(dom.window.localStorage.getItem("other")).toBe("keep");
});

test("reports blocked storage, protects in-memory typing, and can clear without storage access", () => {
  const original = Object.getOwnPropertyDescriptor(dom.window, "localStorage");
  Object.defineProperty(dom.window, "localStorage", {
    configurable: true,
    get() {
      throw new Error("Denied");
    },
  });
  try {
    expect(pwaDrafts.write("a", "chat", "still typing")).toBe(false);
    expect(pwaDrafts.read("a", "chat")).toBe("still typing");
    expect(pwaDrafts.has("a")).toBe(true);
    pwaDrafts.clearAll();
    expect(pwaDrafts.has("a")).toBe(false);
  } finally {
    if (original) Object.defineProperty(dom.window, "localStorage", original);
    else Reflect.deleteProperty(dom.window, "localStorage");
  }
});
