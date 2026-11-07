import { expect, test } from "bun:test";
import type { MermaidConfig } from "mermaid";
import { renderMermaid } from "./mermaid-render";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("serializes renders in call order and keeps each config until its render finishes", async () => {
  const configs: MermaidConfig[] = [{ theme: "dark" }, { theme: "base", htmlLabels: false }, { theme: "forest" }];
  const gates = configs.map(() => deferred());
  const started = configs.map(() => deferred());
  const initialized: MermaidConfig[] = [];
  const calls: string[] = [];
  const seen: MermaidConfig[] = [];
  let currentConfig: MermaidConfig = {};
  let active = 0;
  let maximumActive = 0;
  const mermaid = {
    initialize(config: MermaidConfig) {
      currentConfig = config;
      initialized.push(config);
    },
    async render(id: string, source: string) {
      const index = calls.length;
      calls.push(id);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started[index]!.resolve();
      await gates[index]!.promise;
      seen.push(currentConfig);
      active -= 1;
      return { svg: source, diagramType: "flowchart" };
    },
  };

  const results = configs.map((config, index) => renderMermaid(mermaid, config, `diagram-${index}`, `source-${index}`));
  for (let index = 0; index < configs.length; index++) {
    await started[index]!.promise;
    expect(calls).toEqual(configs.slice(0, index + 1).map((_, i) => `diagram-${i}`));
    expect(initialized).toEqual(configs.slice(0, index + 1));
    gates[index]!.resolve();
  }
  expect((await Promise.all(results)).map(({ svg }) => svg)).toEqual(["source-0", "source-1", "source-2"]);
  expect(seen).toEqual(configs);
  expect(maximumActive).toBe(1);
});

test("a rejected render reaches its caller without blocking the next config and render", async () => {
  let currentConfig: MermaidConfig = {};
  const seen: MermaidConfig[] = [];
  const mermaid = {
    initialize(config: MermaidConfig) {
      currentConfig = config;
    },
    async render(id: string) {
      // Read the config asynchronously, like Mermaid's internal render queue.
      await Promise.resolve();
      seen.push(currentConfig);
      if (id === "broken") throw new Error("Invalid diagram");
      return { svg: "<svg/>", diagramType: "flowchart" };
    },
  };
  const brokenConfig: MermaidConfig = { theme: "dark" };
  const nextConfig: MermaidConfig = { theme: "base", htmlLabels: false };
  const failed = renderMermaid(mermaid, brokenConfig, "broken", "invalid");
  const next = renderMermaid(mermaid, nextConfig, "next", "flowchart LR; A-->B");

  await expect(failed).rejects.toThrow("Invalid diagram");
  expect((await next).svg).toBe("<svg/>");
  expect(seen).toEqual([brokenConfig, nextConfig]);
});
