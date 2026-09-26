import { describe, expect, test } from "bun:test";
import type { CloudCliContext, CloudCliModule } from "@k2b/cloud/cli";
import { FIRST_PARTY_MODULES, firstPartyModuleSource } from "../test/fixtures/first-party";

/** Every first-party module, loaded from its source: each one must follow the host's help contract. */
const appModules: CloudCliModule[] = await Promise.all(
  Object.keys(FIRST_PARTY_MODULES).map(async (name) => {
    const module = ((await import(firstPartyModuleSource(name))) as { default: CloudCliModule }).default;
    if (module.name !== name) throw new Error(`Module ${name} exports the name "${module.name}"`);
    return module;
  }),
);

const renderHelp = async (module: CloudCliModule, path: string[]): Promise<string[]> => {
  const lines: string[] = [];
  const unavailable = (): never => {
    throw new Error("Help rendering must not access Cloud runtime services.");
  };
  const context: CloudCliContext = {
    args: [...path, "help"],
    flags: {},
    options: { profile: "test", server: "https://cloud.example.test", token: "test", output: "text" },
    getDefault: unavailable,
    setDefault: unavailable,
    createApiClient: unavailable,
    fetch: unavailable,
    readJson: unavailable,
    print: (value = "") => lines.push(value),
    write: unavailable,
    error: unavailable,
    json: unavailable,
    jsonLine: unavailable,
    table: unavailable,
  };

  expect(await module.run(context)).toBe(0);
  return lines.join("\n").split("\n");
};

describe("app CLI help", () => {
  test("describes every visible command group without the generic fallback", async () => {
    for (const module of appModules) {
      const queue: string[][] = [[]];
      const seen = new Set<string>();

      while (queue.length > 0) {
        const path = queue.shift()!;
        const key = path.join(" ");
        if (seen.has(key)) continue;
        seen.add(key);

        const lines = await renderHelp(module, path);
        const commandsStart = lines.indexOf("Commands:");
        if (commandsStart < 0) continue;

        expect(lines[2], `cld ${module.name} ${key}`.trim()).not.toBe("Commands");
        for (let index = commandsStart + 1; index < lines.length && lines[index] !== ""; index += 1) {
          const line = lines[index]!.trim();
          expect(line, `cld ${module.name} ${key}`.trim()).not.toMatch(/\sCommands$/);
          const child = line.split(/\s+/)[0];
          if (child && child !== "(none)") queue.push([...path, child]);
        }
      }
    }
  });
});
