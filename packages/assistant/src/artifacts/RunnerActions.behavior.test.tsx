import { expect, test } from "bun:test";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { createDomTestHarness } from "../../../ui/test/dom";

test("standalone readers retain personal controls while public visitors only manage local data", async () => {
  const dom = createDomTestHarness();
  const { RunnerActions } = await import("./RunnerActions");
  const [serverAccess, setServerAccess] = createSignal(true);
  const dispose = render(() => <RunnerActions id="App001" userId="reader" serverAccess={serverAccess()} />, dom.root);
  try {
    expect(dom.root.textContent).toContain("Create your own copy");
    expect(dom.root.textContent).toContain("Secrets");
    expect(dom.root.textContent).toContain("Local data");
    expect(dom.root.textContent).toContain("Copy app link");
    expect(dom.root.textContent).not.toContain("Manage access");
    setServerAccess(false);
    expect(dom.root.textContent).not.toContain("Create your own copy");
    expect(dom.root.textContent).not.toContain("Secrets");
    expect(dom.root.textContent).toContain("Local data");
  } finally { dispose(); dom.cleanup(); }
});
