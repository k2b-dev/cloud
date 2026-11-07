import { expect, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import * as tasks from "@k2b/cloud/ai/tasks";
import { applicationAiRuntime } from "./application-ai-runtime";

test("retained Mail helpers and application AI lifecycle load without rule adapters", async () => {
  const bundle = await Bun.build({
    entrypoints: ["template-rendering.ts", "command-message-state.ts", "application-ai-runtime.ts"].map((name) =>
      resolve(import.meta.dir, name),
    ),
    target: "bun",
    packages: "external",
    plugins: [
      {
        name: "no-mail-rule-adapters",
        setup(build) {
          build.onResolve({ filter: /(?:workflows\/|service\/workflow-|\.\/workflow-|automation-effect-state)/ }, ({ importer, path }) => {
            if (importer.includes("/packages/mail/src/"))
              throw new Error(`Retained Mail helper loads a rule adapter: ${importer} -> ${path}`);
          });
        },
      },
    ],
  });
  expect(bundle.logs.filter((log) => log.level === "error")).toEqual([]);
  expect(bundle.success).toBe(true);
});

test("application AI has its own serialized lifecycle without starting Mail workflows", async () => {
  const entered = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const events: string[] = [];
  const start = spyOn(tasks, "startWorkflowAiRuntime").mockImplementation(async () => {
    events.push("starting");
    entered.resolve();
    await started.promise;
    events.push("started");
  });
  const stop = spyOn(tasks, "stopWorkflowAiRuntime").mockImplementation(async () => {
    events.push("stopped");
  });
  try {
    const first = applicationAiRuntime.start();
    await entered.promise;
    const second = applicationAiRuntime.start();
    const stopping = applicationAiRuntime.stop();
    expect(events).toEqual(["starting"]);
    started.resolve();
    await Promise.all([first, second, stopping]);
    expect(events).toEqual(["starting", "started", "stopped"]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  } finally {
    started.resolve();
    await applicationAiRuntime.stop();
    start.mockRestore();
    stop.mockRestore();
  }
});
