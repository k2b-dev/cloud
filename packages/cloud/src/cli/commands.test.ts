import { describe, expect, test } from "bun:test";
import {
  arg,
  type CloudCliContext,
  type CloudCliFlags,
  command,
  confirmFlag,
  defineCliCommands,
  flag,
  paginationFlags,
  readCliInput,
} from "./index";

const createContext = (args: string[], flags: CloudCliFlags = {}) => {
  const lines: string[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://example.test", token: "token", output: "text" },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: (() => {
      throw new Error("not needed");
    }) as CloudCliContext["createApiClient"],
    fetch: async () => Response.json({}),
    readJson: async (response) => response.json(),
    print: (value = "") => lines.push(value),
    write: async (value) => void lines.push(value),
    error: (value) => lines.push(value),
    json: (value) => lines.push(JSON.stringify(value, null, 2)),
    jsonLine: (value) => lines.push(JSON.stringify(value)),
    table: () => undefined,
  };
  return { ctx, lines };
};

describe("CLI command builder", () => {
  test("preserves aliases and normalizes exact shortcut command paths", () => {
    const mod = defineCliCommands({
      name: "inventory",
      summary: "Inventory",
      alias: "inv",
      shortcuts: { stock: "  items   list\t" },
      commands: [command("items list", { summary: "List", run: () => 0 })],
    });
    expect(mod.alias).toBe("inv");
    expect(mod.shortcuts).toEqual({ stock: "items list" });
    const plain = defineCliCommands({ name: "inventory", summary: "Inventory", commands: [] });
    expect(Object.hasOwn(plain, "alias")).toBe(false);
    expect(Object.hasOwn(plain, "shortcuts")).toBe(false);
  });

  test("allows a shortcut to a group only when the group has its own command", () => {
    const mod = defineCliCommands({
      name: "inventory",
      summary: "Inventory",
      shortcuts: { stock: "items" },
      commands: [command("items", { summary: "Items", run: () => 0 }), command("items list", { summary: "List", run: () => 0 })],
    });
    expect(mod.shortcuts).toEqual({ stock: "items" });
  });

  test("rejects invalid or repeated short names and non-command targets", () => {
    const config = { name: "inventory", summary: "Inventory", commands: [command("items list", { summary: "List", run: () => 0 })] };
    for (const alias of ["", "Inv", "1inv", "inv_name", "inventory"]) {
      expect(() => defineCliCommands({ ...config, alias })).toThrow("CLI alias");
    }
    for (const name of ["", "Stock", "1stock", "stock_name", "inventory", "inv"]) {
      expect(() => defineCliCommands({ ...config, alias: "inv", shortcuts: { [name]: "items list" } })).toThrow("CLI shortcuts");
    }
    for (const target of ["", "  ", "items list --json", "-h"]) {
      expect(() => defineCliCommands({ ...config, shortcuts: { stock: target } })).toThrow("CLI shortcuts");
    }
    for (const target of ["items", "unknown", "items list extra"]) {
      expect(() => defineCliCommands({ ...config, shortcuts: { stock: target } })).toThrow("Unknown CLI shortcut command path");
    }
  });

  test("lets one command in a Cloud-backed module run offline", () => {
    const mod = defineCliCommands({
      name: "inventory",
      summary: "Inventory",
      commands: [
        command("items list", { summary: "List items", run: () => undefined }),
        command("package verify", { summary: "Verify a package", requiresCloud: false, run: () => undefined }),
      ],
    });

    expect(mod.requiresCloudFor?.(["items", "list"], {})).toBe(true);
    expect(mod.requiresCloudFor?.(["package", "verify", "local.tar"], {})).toBe(false);
  });

  test("dispatches a root command without hiding named commands", async () => {
    const calls: unknown[] = [];
    const mod = defineCliCommands({
      name: "assistant",
      summary: "Chat and manage Assistant",
      commands: [
        command("", {
          summary: "Chat with Assistant",
          args: { prompt: arg.rest() },
          flags: { print: flag.boolean({ aliases: ["p"] }) },
          examples: ["cld assistant", 'cld assistant -p "Hello"'],
          run: ({ args, flags }) => void calls.push({ command: "root", args, flags }),
        }),
        command("status", {
          summary: "Show status",
          run: () => void calls.push({ command: "status" }),
        }),
      ],
    });

    expect(mod.booleanFlags).toContain("p");
    await mod.run(createContext([], {}).ctx);
    await mod.run(createContext(["Hello"], { p: true }).ctx);
    await mod.run(createContext(["status"], {}).ctx);

    expect(calls).toEqual([
      { command: "root", args: { prompt: [] }, flags: { print: false } },
      { command: "root", args: { prompt: ["Hello"] }, flags: { print: true } },
      { command: "status" },
    ]);
    const help = mod.help?.() ?? "";
    expect(help).toContain("cld assistant [<prompt...>] [options]");
    expect(help).toContain("cld assistant <command> [options]");
    expect(help).toContain("--print, -p");
  });

  test("dispatches nested commands with typed args and flags", async () => {
    let captured: unknown;
    const mod = defineCliCommands({
      name: "admin",
      summary: "Admin commands",
      commands: [
        command("logs list", {
          summary: "List logs",
          args: { source: arg.optional() },
          flags: {
            search: flag.string({ aliases: ["q"] }),
            level: flag.enum(["info", "warn", "error"] as const),
            ...paginationFlags({ defaultPerPage: 25 }),
          },
          run: ({ args, flags }) => {
            captured = { args, flags };
          },
        }),
      ],
    });

    const { ctx } = createContext(["logs", "list", "gateway"], {
      q: "timeout",
      level: "error",
      page: "2",
      "per-page": "10",
    });

    await mod.run(ctx);
    expect(captured).toEqual({
      args: { source: "gateway" },
      flags: { search: "timeout", level: "error", page: 2, perPage: 10 },
    });
  });

  test("parses repeated string list flags and boolean aliases", async () => {
    let captured: unknown;
    const mod = defineCliCommands({
      name: "admin",
      summary: "Admin commands",
      commands: [
        command("webhooks create", {
          summary: "Create webhook",
          flags: {
            sendOn: flag.stringList({ name: "send-on" }),
            yes: confirmFlag(),
          },
          run: ({ flags }) => {
            captured = flags;
          },
        }),
      ],
    });

    expect(mod.booleanFlags).toContain("yes");
    await mod.run(createContext(["webhooks", "create"], { "send-on": ["error,recovery", "warn"], yes: true }).ctx);
    expect(captured).toEqual({ sendOn: ["error", "recovery", "warn"], yes: true });
  });

  test("does not collect colliding value flags as module-level booleans", async () => {
    let captured: unknown;
    const mod = defineCliCommands({
      name: "notes",
      summary: "Note commands",
      commands: [
        command("read", {
          summary: "Read note",
          flags: { content: flag.boolean({ description: "Include content" }) },
          run: ({ flags }) => {
            captured = flags;
          },
        }),
        command("edit", {
          summary: "Edit note",
          flags: { content: flag.string({ description: "Markdown content" }) },
          run: ({ flags }) => {
            captured = flags;
          },
        }),
      ],
    });

    expect(mod.booleanFlags).not.toContain("content");

    await mod.run(createContext(["edit"], { content: "hello" }).ctx);
    expect(captured).toEqual({ content: "hello" });

    await mod.run(createContext(["read"], { content: true }).ctx);
    expect(captured).toEqual({ content: true });
  });

  test("renders root, subtree, command, and flag help", async () => {
    const mod = defineCliCommands({
      name: "admin",
      summary: "Admin commands",
      groupSummaries: { logs: "Inspect application logs", "logs archived": "Inspect archived logs" },
      commands: [
        command("logs list", {
          summary: "List logs",
          flags: { search: flag.string({ aliases: ["q"], description: "Free-text search" }) },
          examples: ["cld admin logs list --search timeout"],
          run: () => undefined,
        }),
        command("logs archived list", {
          summary: "List archived logs",
          run: () => undefined,
        }),
      ],
    });

    const rootHelp = mod.help?.() ?? "";
    expect(rootHelp).toContain("cld admin");
    expect(rootHelp).toContain("logs           Inspect application logs");

    const subtree = createContext(["logs", "help"]);
    await mod.run(subtree.ctx);
    expect(subtree.lines.join("\n")).toContain("cld admin logs");
    expect(subtree.lines.join("\n")).toContain("Inspect application logs");
    expect(subtree.lines.join("\n")).toContain("archived       Inspect archived logs");

    const commandHelp = createContext(["logs", "list"], { help: true });
    await mod.run(commandHelp.ctx);
    const output = commandHelp.lines.join("\n");
    expect(output).toContain("cld admin logs list");
    expect(output).toContain("--search <value>, -q");
    expect(output).toContain("cld admin logs list --search timeout");
  });

  test("rejects summaries for paths that are not generated command groups", () => {
    expect(() =>
      defineCliCommands({
        name: "admin",
        summary: "Admin commands",
        groupSummaries: { missing: "Missing commands" },
        commands: [command("logs list", { summary: "List logs", run: () => undefined })],
      }),
    ).toThrow("Unknown generated CLI command group: missing");

    expect(() =>
      defineCliCommands({
        name: "admin",
        summary: "Admin commands",
        groupSummaries: { logs: "" },
        commands: [command("logs list", { summary: "List logs", run: () => undefined })],
      }),
    ).toThrow('CLI command group "logs" requires a summary.');
  });

  test("rejects missing args, invalid ints, invalid enums, and unknown flags", async () => {
    const mod = defineCliCommands({
      name: "admin",
      summary: "Admin commands",
      commands: [
        command("logs get", {
          summary: "Get log",
          args: { id: arg.required() },
          flags: {
            page: flag.int({ min: 1 }),
            level: flag.enum(["info", "warn", "error"] as const),
          },
          run: () => undefined,
        }),
      ],
    });

    await expect(mod.run(createContext(["logs", "get"]).ctx)).rejects.toThrow("Missing id");
    await expect(mod.run(createContext(["logs", "get", "1"], { page: "0" }).ctx)).rejects.toThrow("--page must be at least 1");
    await expect(mod.run(createContext(["logs", "get", "1"], { level: "debug" }).ctx)).rejects.toThrow(
      "--level must be one of: info, warn, error",
    );
    await expect(mod.run(createContext(["logs", "get", "1"], { nope: "x" }).ctx)).rejects.toThrow("Unknown flag");
  });

  test("tolerates global output flags in the trailing position", async () => {
    let ran = 0;
    const mod = defineCliCommands({
      name: "admin",
      summary: "Admin commands",
      commands: [
        command("logs list", {
          summary: "List logs",
          run: () => {
            ran += 1;
          },
        }),
      ],
    });

    // The runner reads global flags without consuming them, so they reach the
    // command parser. `cld admin logs list --jsonl` must behave like `--json`.
    const globalFlagCombinations: CloudCliFlags[] = [{ json: true }, { jsonl: true }, { json: true, jsonl: true }];
    for (const flags of globalFlagCombinations) {
      await mod.run(createContext(["logs", "list"], flags).ctx);
    }

    expect(ran).toBe(3);
  });

  test("detects conflicting input sources", async () => {
    const mod = defineCliCommands({
      name: "admin",
      summary: "Admin commands",
      commands: [
        command("announcements create", {
          summary: "Create announcement",
          flags: { body: flag.input({ required: true }) },
          run: async ({ flags }) => {
            await readCliInput(flags.body, { required: true });
          },
        }),
      ],
    });

    await expect(mod.run(createContext(["announcements", "create"], { body: "hello", "body-file": "body.md" }).ctx)).rejects.toThrow(
      "Pass only one of --body, --body-file, or --stdin",
    );
  });
});
