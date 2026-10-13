import { afterAll, afterEach, expect, test } from "bun:test";
import { ErrorBoundary } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { desktopWindowSearchParams, readDesktopWindowDescriptor } from "./index";

const dom = createDomTestHarness();
const { defineDesktopWindows, DesktopWindowHost } = await import("./solid");
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  dom.root.replaceChildren();
  window.history.replaceState(null, "", "/");
  Reflect.deleteProperty(globalThis, "pwned");
});
afterAll(() => dom.cleanup());

test.each(["x", "unregistered", "constructor", "toString", "__proto__"])("hostile desktop props are contained for %s", (name) => {
  window.location.hash = `__cloudDesktopWindow=${name}&__cloudDesktopWindowProps=globalThis.pwned%3D1`;
  const registry = defineDesktopWindows({ x: () => <b>Window</b> });
  dispose = render(
    () => (
      <ErrorBoundary fallback={<b>Fallback</b>}>
        <DesktopWindowHost windows={registry}>Children</DesktopWindowHost>
      </ErrorBoundary>
    ),
    dom.root,
  );
  expect(dom.root.textContent).toBe(name === "x" ? "Fallback" : "Children");
  expect(Reflect.get(globalThis, "pwned")).toBeUndefined();
});

test("desktop descriptors round-trip Date and Map as JSON data", () => {
  const props = { at: new Date("2026-10-01T12:34:56Z"), tags: new Map([["k", "v"]]) };
  let received: typeof props | undefined;
  const registry = defineDesktopWindows({
    Viewer: (value: typeof props) => {
      received = value;
      return <b>Viewer</b>;
    },
  });
  const descriptor: unknown = registry.Viewer(props);
  if (!descriptor || typeof descriptor !== "object" || !("props" in descriptor) || typeof descriptor.props !== "string")
    throw new Error("Expected desktop descriptor props");
  const params = new URLSearchParams({
    [desktopWindowSearchParams.name]: "Viewer",
    [desktopWindowSearchParams.props]: descriptor.props,
  });
  window.location.hash = params.toString();
  expect(readDesktopWindowDescriptor()?.name).toBe("Viewer");
  dispose = render(
    () => (
      <ErrorBoundary fallback={<b>Fallback</b>}>
        <DesktopWindowHost windows={registry}>Children</DesktopWindowHost>
      </ErrorBoundary>
    ),
    dom.root,
  );
  expect(dom.root.textContent).toBe("Viewer");
  expect(received?.at.getTime()).toBe(props.at.getTime());
  expect([...(received?.tags ?? [])]).toEqual([...props.tags]);
  expect(() => JSON.parse(readDesktopWindowDescriptor()!.props)).not.toThrow();
});
