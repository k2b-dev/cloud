import { expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
domTest(
  "a resource opens only after its canonical reader authorizes it",
  async () => {
    const dom = createDomTestHarness();
    const { compileCapabilityManifest } = await import("@k2b/cloud/capabilities/testing");
    const { defineCapabilities } = await import("@k2b/cloud/contracts");
    const { z } = await import("zod");
    const manifest = compileCapabilityManifest(
      "example",
      defineCapabilities({
        protocolVersion: 2,
        types: { file: { title: "File", description: "A file", reader: "file.read" } },
        queries: {
          "file.read": {
            title: "Read",
            description: "Read file",
            input: z.object({ id: z.string().describe("Resource identifier") }).strict(),
            data: z.object({}),
            openWorld: false,
            run: async () => ({ ok: true as const, data: { data: {} } }),
          },
        },
      }),
    );
    let reads = 0;
    mock.module("@k2b/cloud/capabilities", () => ({
      listCapabilityCatalog: async () => ({ ok: true, data: { apps: [{ appId: "example", manifest }], page: { hasMore: false } } }),
      invokeCapability: async () => {
        reads++;
        return { ok: false, error: { message: "denied" } };
      },
    }));
    const { default: ResourceValue } = await import("./ResourceValue");
    const { prompts } = await import("@k2b/ui");
    const error = mock(() => Promise.resolve());
    const original = prompts.error;
    prompts.error = error;
    const dispose = render(() => createComponent(ResourceValue, { value: { type: "example.file", id: "file1", title: "File" } }), dom.root);
    try {
      const button = dom.root.querySelector("button");
      expect(button).not.toBeNull();
      button!.click();
      await Bun.sleep(20);
      expect(reads).toBe(1);
      expect(error).toHaveBeenCalledTimes(1);
      expect(dom.root.querySelector("a")).toBeNull();
    } finally {
      prompts.error = original;
      dispose();
      dom.cleanup();
      mock.restore();
    }
  },
  30_000,
);
