import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { SOURCE_TAB_CORE_ROWS, SOURCE_TAB_ENABLED, SOURCE_TAB_VERSIONS, sourceTabFixture } from "./source-tab.fixture";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    const [{ CodeSourceTab }, { LocaleProvider }, client, contracts] = await Promise.all([
      import("./CodeSourceTab"),
      import("@k2b/ui"),
      import("../../capabilities/client"),
      import("../../contracts/capabilities"),
    ]);
    return { CodeSourceTab, LocaleProvider, client, contracts };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

type Input = { path?: string; comparisonVersionId?: string; sourceOffset: number; diffOffset: number };
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const waitFor = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) await flush();
  expect(check()).toBe(true);
};

/** Mounts the tab on its address with a fictional Core; `answer` decides each request. */
const mount = (answer: (input: Input) => "ok" | "fail" | "wait", locale = "de") => {
  const dom = createDomTestHarness();
  const { CodeSourceTab, LocaleProvider, client, contracts } = modules!;
  dom.window.history.replaceState(null, "", "/mail/m_info/code?tab=code");
  const inputs: Input[] = [];
  const pending: (() => void)[] = [];
  const invoke = spyOn(client, "invokeCapabilityWithDataSchema").mockImplementation(async (invocation, schema) => {
    const input = invocation.input as Input;
    inputs.push(input);
    const outcome = answer(input);
    if (outcome === "wait") await new Promise<void>((resolve) => pending.push(resolve));
    if (outcome === "fail") return { ok: false, error: { code: "INTERNAL", message: "Fixture failure", status: 500 } };
    const path = input.path ?? "code.ts";
    const text = path === "seite.tsx" ? "export default 1;" : "const answer = 42;";
    return {
      ok: true,
      data: contracts.capabilityResultSchema(schema).parse({
        data: {
          enabled: { ...SOURCE_TAB_ENABLED, codeId: "c_lea" },
          path,
          source: input.sourceOffset > text.length ? { text: "", nextOffset: null } : { text, nextOffset: null },
          difference: input.comparisonVersionId ? { text: JSON.stringify(SOURCE_TAB_CORE_ROWS), nextOffset: null } : null,
          versions: SOURCE_TAB_VERSIONS,
          nextBefore: null,
        },
      }),
    };
  });
  delegateEvents(["click", "keydown"]);
  const dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(CodeSourceTab, {
            data: sourceTabFixture("code"),
            codeId: "c_lea",
            href: "/mail/m_info/code?tab=code",
            versionsHref: "/mail/m_info/code?tab=versions",
          });
        },
      }),
    dom.root,
  );
  const cleanup = () => {
    dispose();
    invoke.mockRestore();
    dom.cleanup();
  };
  return { dom, inputs, pending, cleanup };
};

const chooseVersion = async (dom: ReturnType<typeof createDomTestHarness>, label: string) => {
  dom.document.querySelector<HTMLButtonElement>('button[role="combobox"]')!.click();
  await waitFor(() => [...dom.document.querySelectorAll('[role="option"]')].some((node) => node.textContent?.includes(label)));
  [...dom.document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) => node.textContent?.includes(label))!.click();
};

test.skipIf(isServer)("choosing a version compares in the same field, keeps the address and announces what changed", async () => {
  const { dom, inputs, cleanup } = mount(() => "ok");
  try {
    await chooseVersion(dom, "Version 3");
    await waitFor(() => dom.root.textContent?.includes("+2 −1") ?? false);
    expect(inputs.at(-1)?.comparisonVersionId).toBe(SOURCE_TAB_VERSIONS[0]!.versionId);
    expect(dom.window.location.search).toBe(`?tab=code&file=code.ts&compare=${SOURCE_TAB_VERSIONS[0]!.versionId}`);
    expect(dom.root.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe(
      "Vergleich mit Version 3: 2 Zeilen dazu, 1 Zeile weg",
    );
    expect(dom.root.querySelectorAll('[data-kind="del"]')).toHaveLength(1);
    // Files inside a comparison switch without asking Core again.
    const asked = inputs.length;
    [...dom.root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.includes("seite.tsx"))!.click();
    await flush();
    expect(inputs).toHaveLength(asked);
    expect(dom.window.location.search).toContain("file=seite.tsx");
    // Back to the code alone, from the cache.
    await chooseVersion(dom, "Nichts");
    await waitFor(
      () => dom.root.querySelector('[role="status"][aria-live="polite"]')?.textContent === "Der Code der eingeschalteten Version",
    );
    expect(dom.window.location.search).toBe("?tab=code&file=seite.tsx");
    expect(dom.root.textContent).toContain("export default 1;");
  } finally {
    cleanup();
  }
});

test.skipIf(isServer)("another file loads into the same field and its tab stays put meanwhile", async () => {
  const { dom, pending, cleanup } = mount(() => "wait");
  try {
    [...dom.root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((tab) => tab.textContent?.includes("seite.tsx"))!.click();
    await flush();
    expect(dom.root.querySelector('.k2b-code-diff__body[aria-busy="true"]')).not.toBeNull();
    expect(dom.root.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(dom.window.location.search).toBe("?tab=code&file=seite.tsx");
    for (const resolve of pending.splice(0)) resolve();
    await waitFor(() => dom.root.textContent?.includes("export default 1;") ?? false);
    expect(dom.root.querySelector('[aria-busy="true"]')).toBeNull();
  } finally {
    cleanup();
  }
});

test.skipIf(isServer)("a failed load says nothing changes about the automation and tries again on request", async () => {
  let fail = true;
  const { dom, cleanup } = mount(() => (fail ? "fail" : "ok"));
  try {
    await chooseVersion(dom, "Version 3");
    await waitFor(() => dom.root.querySelector('[role="alert"]') !== null);
    expect(dom.root.textContent).toContain("An der Automation ändert das nichts.");
    fail = false;
    [...dom.root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Erneut versuchen"))!.click();
    await waitFor(() => dom.root.textContent?.includes("+2 −1") ?? false);
    expect(dom.root.querySelector('[role="alert"]')).toBeNull();
  } finally {
    cleanup();
  }
});
