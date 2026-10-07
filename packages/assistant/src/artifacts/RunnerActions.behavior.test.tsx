import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

// Load once outside any test, so the cold Solid transform of the component's source graph does not count against the
// 5 s test timeout. The @k2b/ui browser build needs a document while its modules evaluate.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return (await import("./RunnerActions")).RunnerActions;
  } finally {
    dom.cleanup();
  }
};
const RunnerActions = await load();

test("standalone readers retain personal controls while anonymous visitors have no personal data control", async () => {
  const dom = createDomTestHarness();
  const [serverAccess, setServerAccess] = createSignal(true);
  const dispose = render(() => <RunnerActions id="App001" userId="reader" serverAccess={serverAccess()} />, dom.root);
  try {
    expect(dom.root.textContent).toContain("Create your own copy");
    expect(dom.root.textContent).not.toContain("Secrets");
    expect(dom.root.textContent).toContain("Personal data");
    expect(dom.root.textContent).toContain("Copy app link");
    expect(dom.root.textContent).not.toContain("Manage access");
    setServerAccess(false);
    await Promise.resolve();
    expect(dom.root.textContent).not.toContain("Create your own copy");
    expect(dom.root.textContent).not.toContain("Secrets");
    expect(dom.root.textContent).not.toContain("Personal data");
  } finally {
    dispose();
    dom.cleanup();
  }
});
