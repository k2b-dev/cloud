import { expect, test } from "bun:test";
import { defineCliCommands } from "../commands";
import type { CloudCliContext } from "../index";
import { logCommands } from "./logs";

const module = defineCliCommands({ name: "admin", summary: "Logs", commands: logCommands });
for (const command of ["list", "tail"]) {
  test(`${command} sends and reports the default and selected lookback`, async () => {
    for (const [flags, hours] of [
      [{}, 24],
      [{ since: "7d" }, 168],
    ] as const) {
      const paths: string[] = [];
      const output: unknown[] = [];
      const ctx: CloudCliContext = {
        args: ["logs", command],
        flags: flags,
        options: { profile: "test", server: "https://test.example", token: "test", output: "json" },
        getDefault: async () => undefined,
        setDefault: async () => {},
        createApiClient: () => {
          throw new Error("Unused");
        },
        fetch: async (path) => {
          paths.push(path);
          return Response.json({ entries: [], pagination: { page: 1, perPage: 20, total: 0, totalPages: 0 } });
        },
        readJson: async (response) => response.json(),
        print: (value) => output.push(value),
        json: (value) => output.push(value),
        jsonLine: (value) => output.push(value),
        write: async () => {},
        error: () => {},
        table: () => {},
      };
      await module.run(ctx);
      expect(new URL(paths[0]!, "https://test.example").searchParams.get("since_hours")).toBe(String(hours));
      expect(output[0]).toMatchObject({ sinceHours: hours });
    }
  });
}
