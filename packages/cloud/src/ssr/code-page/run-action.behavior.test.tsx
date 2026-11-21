import { expect, spyOn, test } from "bun:test";
import { createRoot } from "solid-js";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { capabilityResultSchema } from "../../contracts/capabilities";
import { headActionFixture } from "./head-action.fixture";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    const [{ createRunAction }, { runItems }, { createCodeLive }, { usePageText }, client, { toast }] = await Promise.all([
      import("./run-action"),
      import("./CodeLaunch"),
      import("./CodeLiveStrip"),
      import("./page-kit"),
      import("../../capabilities/client"),
      import("@k2b/ui"),
    ]);
    return { createRunAction, runItems, createCodeLive, usePageText, client, toast };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

test.skipIf(isServer)("concurrent entries retain each pending state and receipt when the second finishes first", async () => {
  const dom = createDomTestHarness();
  const { createRunAction, runItems, createCodeLive, usePageText, client, toast } = modules!;
  const data = headActionFixture("schedules", "en");
  if (data.state.kind !== "ready") throw new Error("Expected ready fixture");
  const state = data.state;
  const completes: (() => void)[] = [];
  const invoke = spyOn(client, "invokeCapabilityWithDataSchema").mockImplementation(async (_invocation, schema) => {
    const index = completes.length;
    await new Promise<void>((resolve) => {
      completes.push(resolve);
    });
    return {
      ok: true,
      data: capabilityResultSchema(schema).parse({
        data: {
          runId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          duplicate: false,
        },
      }),
    };
  });
  const success = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
  const model = createRoot((dispose) => {
    const live = createCodeLive(state);
    const text = usePageText(() => data);
    const run = createRunAction({ data, state: () => state, live, text, reconcile: () => {} });
    return { dispose, run, live, items: () => runItems(state, text, run) };
  });
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  try {
    model.items()[1]!.action!();
    await tick();
    expect(model.items().map((item) => item.disabled)).toEqual([false, true]);
    model.items()[0]!.action!();
    await tick();
    expect(model.items().map((item) => item.disabled)).toEqual([true, true]);
    expect(completes).toHaveLength(2);
    completes[1]!();
    await tick();
    expect(model.items().map((item) => item.disabled)).toEqual([false, true]);
    expect(model.live.runs().find((run) => run.id.endsWith("000000000002"))).toMatchObject({
      entrypoint: "wochenbericht",
      startedHere: true,
    });
    completes[0]!();
    await tick();
    expect(model.items().map((item) => item.disabled)).toEqual([false, false]);
    expect(
      model.live
        .runs()
        .filter((run) => run.startedHere)
        .map((run) => run.entrypoint)
        .sort(),
    ).toEqual(["reminder", "wochenbericht"]);
    expect(success).toHaveBeenCalledTimes(2);
  } finally {
    model.dispose();
    invoke.mockRestore();
    success.mockRestore();
    dom.cleanup();
  }
});
