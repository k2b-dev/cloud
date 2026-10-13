import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toJSON } from "seroval";
import { buildIslands } from "../../src/build";
import { islandIdFromFile } from "../../src/island-id";
import { makeTempRoot } from "../temp-root";

const roots: string[] = [];
afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "receiveProps");
  Reflect.deleteProperty(globalThis, "pwned");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const build = async () => {
  const root = makeTempRoot(".ssr-island-props-");
  roots.push(root);
  const file = join(root, "Probe.island.tsx");
  writeFileSync(file, `export default function Probe(props) { globalThis.receiveProps?.(props); return <b>Mounted</b>; }`);
  await buildIslands({ pattern: "**/*.island.tsx", cwd: root, outdir: join(root, "_ssr"), verbose: false, dev: true });
  const id = islandIdFromFile(file, root);
  return { id, load: () => import(join(root, "_ssr", `${id}.js`)) };
};
const attribute = (props: object) => JSON.stringify(toJSON(props)).replaceAll("&", "&amp;").replaceAll('"', "&quot;");

test("rich props mount as JSON data with eval and Function disabled", async () => {
  const bundle = await build();
  const shared = { label: "shared" };
  const props = {
    at: new Date("2026-10-01T12:34:56Z"),
    map: new Map([["k", shared]]),
    set: new Set(["a", "b"]),
    shared,
    missing: undefined,
    text: '</script>"&',
  };
  document.body.innerHTML = `<solid-island data-id="${bundle.id}" data-props="${attribute(props)}">SSR</solid-island>`;
  let errors = 0;
  document.querySelector("solid-island")!.addEventListener("ssr:island-error", (event) => {
    errors++;
    event.preventDefault();
  });
  const disabled = () => {
    throw new Error("Props must never be evaluated");
  };
  const evalSpy = spyOn(globalThis, "eval").mockImplementation(disabled);
  const originalFunction = Object.getOwnPropertyDescriptor(globalThis, "Function")!;
  Object.defineProperty(globalThis, "Function", { configurable: true, writable: true, value: disabled });
  let received: typeof props | undefined;
  Reflect.set(globalThis, "receiveProps", (value: typeof props) => {
    received = value;
  });
  try {
    await bundle.load();
    if (!received) throw new Error("Island did not receive props");
    expect(received.at.getTime()).toBe(props.at.getTime());
    expect([...received.map]).toEqual([...props.map]);
    expect([...received.set]).toEqual([...props.set]);
    expect(received.shared === received.map.get("k")).toBe(true);
    expect("missing" in received && received.missing === undefined).toBe(true);
    expect(received.text).toBe(props.text);
    expect(errors).toBe(0);
  } finally {
    Object.defineProperty(globalThis, "Function", originalFunction);
    evalSpy.mockRestore();
  }
});

test.each(["globalThis.pwned=1", '({label:"old"})', undefined])(
  "invalid or missing props are contained without executing (%s)",
  async (value) => {
    const bundle = await build();
    document.body.innerHTML = `<solid-island data-id="${bundle.id}"${value === undefined ? "" : ` data-props="${value.replaceAll('"', "&quot;")}"`}>SSR</solid-island>`;
    const element = document.querySelector("solid-island")!;
    let errors = 0;
    element.addEventListener("ssr:island-error", (event) => {
      errors++;
      event.preventDefault();
    });
    await bundle.load();
    expect(element.querySelector("[role=alert][data-ssr-error]")).not.toBeNull();
    expect(errors).toBe(1);
    expect(Reflect.get(globalThis, "pwned")).toBeUndefined();
  },
);
