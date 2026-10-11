import { readFile } from "node:fs/promises";
import type { CloudCliContext, CloudCliFlagValue, CloudCliModule } from "./index";
import { isCloudCliAlias, isCloudCliShortcuts } from "./plugin";

type FlagKind = "string" | "boolean" | "int" | "enum" | "stringList" | "input";
type ArgKind = "required" | "optional" | "rest";

type BaseFlagOptions = {
  name?: string;
  aliases?: readonly string[];
  description?: string;
  valueLabel?: string;
};

type StringFlagSpec = BaseFlagOptions & {
  kind: "string";
  default?: string;
  required?: boolean;
};

type BooleanFlagSpec = BaseFlagOptions & {
  kind: "boolean";
  default?: boolean;
};

type IntFlagSpec = BaseFlagOptions & {
  kind: "int";
  default?: number;
  min?: number;
  max?: number;
  required?: boolean;
};

type EnumFlagSpec<TValue extends string = string> = BaseFlagOptions & {
  kind: "enum";
  values: readonly TValue[];
  default?: TValue;
  required?: boolean;
};

type StringListFlagSpec = BaseFlagOptions & {
  kind: "stringList";
  default?: readonly string[];
  separator?: string;
};

type InputFlagSpec = BaseFlagOptions & {
  kind: "input";
  fileName?: string;
  fileAliases?: readonly string[];
  stdinName?: string | false;
  required?: boolean;
};

export type CliInputFlagValue = {
  source: "value" | "file" | "stdin" | null;
  value?: string;
  file?: string;
  provided: boolean;
};

export type CliFlagSpec = StringFlagSpec | BooleanFlagSpec | IntFlagSpec | EnumFlagSpec | StringListFlagSpec | InputFlagSpec;

type CliFlagSpecs = Record<string, CliFlagSpec>;

type RequiredArgSpec = {
  kind: "required";
  description?: string;
  valueLabel?: string;
};

type OptionalArgSpec = {
  kind: "optional";
  description?: string;
  valueLabel?: string;
};

type RestArgSpec = {
  kind: "rest";
  description?: string;
  valueLabel?: string;
  required?: boolean;
};

export type CliArgSpec = RequiredArgSpec | OptionalArgSpec | RestArgSpec;
type CliArgSpecs = Record<string, CliArgSpec>;

type InferFlag<TSpec> = TSpec extends StringFlagSpec
  ? string | undefined
  : TSpec extends BooleanFlagSpec
    ? boolean
    : TSpec extends IntFlagSpec
      ? number | undefined
      : TSpec extends EnumFlagSpec<infer TValue>
        ? TValue | undefined
        : TSpec extends StringListFlagSpec
          ? string[]
          : TSpec extends InputFlagSpec
            ? CliInputFlagValue
            : never;

type InferFlags<TSpecs extends CliFlagSpecs | undefined> = TSpecs extends CliFlagSpecs
  ? { [K in keyof TSpecs]: InferFlag<TSpecs[K]> }
  : Record<string, never>;

type InferArg<TSpec> = TSpec extends RequiredArgSpec
  ? string
  : TSpec extends OptionalArgSpec
    ? string | undefined
    : TSpec extends RestArgSpec
      ? string[]
      : never;

type InferArgs<TSpecs extends CliArgSpecs | undefined> = TSpecs extends CliArgSpecs
  ? { [K in keyof TSpecs]: InferArg<TSpecs[K]> }
  : Record<string, never>;

export type CliCommandRunContext<TFlags extends CliFlagSpecs | undefined, TArgs extends CliArgSpecs | undefined> = {
  ctx: CloudCliContext;
  flags: InferFlags<TFlags>;
  args: InferArgs<TArgs>;
};

export type CliCommandConfig<TFlags extends CliFlagSpecs | undefined = undefined, TArgs extends CliArgSpecs | undefined = undefined> = {
  summary: string;
  description?: string;
  requiresCloud?: boolean;
  args?: TArgs;
  flags?: TFlags;
  examples?: readonly string[];
  run: (context: CliCommandRunContext<TFlags, TArgs>) => Promise<number | void> | number | void;
};

type CliCommandDefinition = {
  path: readonly string[];
  summary: string;
  description?: string;
  requiresCloud?: boolean;
  args?: CliArgSpecs;
  flags?: CliFlagSpecs;
  examples?: readonly string[];
  run: (context: {
    ctx: CloudCliContext;
    flags: Record<string, unknown>;
    args: Record<string, unknown>;
  }) => Promise<number | void> | number | void;
};

type CommandNode = {
  segment: string;
  children: Map<string, CommandNode>;
  command?: CliCommandDefinition;
  groupSummary?: string;
};

type CliCommandsConfig = {
  name: string;
  summary: string;
  alias?: string;
  shortcuts?: Readonly<Record<string, string>>;
  requiresCloud?: boolean;
  groupSummaries?: Readonly<Record<string, string>>;
  commands: readonly CliCommandDefinition[];
};

export const flag = {
  string: (options: BaseFlagOptions & { default?: string; required?: boolean } = {}): StringFlagSpec => ({ ...options, kind: "string" }),
  boolean: (options: BaseFlagOptions & { default?: boolean } = {}): BooleanFlagSpec => ({ ...options, kind: "boolean" }),
  int: (options: BaseFlagOptions & { default?: number; min?: number; max?: number; required?: boolean } = {}): IntFlagSpec => ({
    ...options,
    kind: "int",
  }),
  enum: <const TValue extends readonly string[]>(
    values: TValue,
    options: BaseFlagOptions & { default?: TValue[number]; required?: boolean } = {},
  ): EnumFlagSpec<TValue[number]> => ({ ...options, kind: "enum", values }),
  stringList: (options: BaseFlagOptions & { default?: readonly string[]; separator?: string } = {}): StringListFlagSpec => ({
    ...options,
    kind: "stringList",
  }),
  input: (
    options: BaseFlagOptions & {
      fileName?: string;
      fileAliases?: readonly string[];
      stdinName?: string | false;
      required?: boolean;
    } = {},
  ): InputFlagSpec => ({ ...options, kind: "input" }),
};

export const arg = {
  required: (options: Omit<RequiredArgSpec, "kind"> = {}): RequiredArgSpec => ({ ...options, kind: "required" }),
  optional: (options: Omit<OptionalArgSpec, "kind"> = {}): OptionalArgSpec => ({ ...options, kind: "optional" }),
  rest: (options: Omit<RestArgSpec, "kind"> = {}): RestArgSpec => ({ ...options, kind: "rest" }),
};

export const paginationFlags = (options: { defaultPerPage?: number; maxPerPage?: number } = {}) => ({
  page: flag.int({ default: 1, min: 1, description: "Page number" }),
  perPage: flag.int({
    name: "per-page",
    aliases: ["per_page"],
    default: options.defaultPerPage ?? 50,
    min: 1,
    max: options.maxPerPage ?? 200,
    description: "Items per page",
  }),
});

export const confirmFlag = (description = "Confirm this operation"): BooleanFlagSpec => flag.boolean({ name: "yes", description });

export const command = <TFlags extends CliFlagSpecs | undefined = undefined, TArgs extends CliArgSpecs | undefined = undefined>(
  path: string,
  config: CliCommandConfig<TFlags, TArgs>,
): CliCommandDefinition => ({
  ...config,
  path: path.split(/\s+/).filter(Boolean),
  run: config.run as CliCommandDefinition["run"],
});

export type ReadCliInputOptions = {
  label?: string;
  required?: boolean;
  trimFinalNewline?: boolean;
};

export const readCliInput = async (input: CliInputFlagValue, options: ReadCliInputOptions = {}): Promise<string | undefined> => {
  const label = options.label ?? "input";
  if (!input.provided) {
    if (options.required) throw new Error(`Missing ${label}.`);
    return undefined;
  }

  const raw =
    input.source === "value"
      ? (input.value ?? "")
      : input.source === "file"
        ? await readFile(input.file ?? "", "utf8")
        : input.source === "stdin"
          ? await Bun.stdin.text()
          : "";

  return options.trimFinalNewline ? raw.replace(/\r?\n$/, "") : raw;
};

export const defineCliCommands = (config: CliCommandsConfig): CloudCliModule => {
  const root = buildCommandTree(config.commands, config.groupSummaries);
  if (config.alias !== undefined && !isCloudCliAlias(config.alias, config.name)) {
    throw new Error("CLI alias must be a lowercase kebab-case name different from the module name");
  }
  let shortcuts: Record<string, string> | undefined;
  if (config.shortcuts !== undefined) {
    if (!isCloudCliShortcuts(config.shortcuts, config.name, config.alias)) {
      throw new Error("CLI shortcuts require unique kebab-case names and non-empty command paths without flags");
    }
    shortcuts = {};
    for (const [name, target] of Object.entries(config.shortcuts)) {
      const segments = target.trim().split(/\s+/);
      if (!findNode(root, segments)?.command) throw new Error(`Unknown CLI shortcut command path: ${target}`);
      shortcuts[name] = segments.join(" ");
    }
  }

  return {
    name: config.name,
    summary: config.summary,
    ...(config.alias !== undefined ? { alias: config.alias } : {}),
    ...(shortcuts !== undefined ? { shortcuts } : {}),
    requiresCloud: config.requiresCloud,
    requiresCloudFor: (args) => {
      const helpRequest = normalizeHelpRequest(args, {});
      if (helpRequest) return false;
      const match = findCommand(root, args);
      return match?.command.requiresCloud ?? config.requiresCloud ?? true;
    },
    booleanFlags: collectBooleanFlags(config.commands),
    help: () => renderHelp(config, root, []),
    async run(ctx) {
      const helpRequest = normalizeHelpRequest(ctx.args, ctx.flags);
      if (helpRequest) {
        ctx.print(renderHelp(config, root, helpRequest));
        return 0;
      }

      const match = findCommand(root, ctx.args);
      if (!match) {
        const hintPath = ctx.args.length > 0 ? ctx.args.join(" ") : config.name;
        throw new Error(`Unknown ${config.name} command "${hintPath}". Run \`cld ${config.name} help\`.`);
      }

      const flags = parseCommandFlags(ctx.flags, match.command.flags);
      const args = parseCommandArgs(match.rest, match.command.args);
      return match.command.run({ ctx, flags, args });
    },
  };
};

const toFlagName = (key: string): string => key.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`);

const buildCommandTree = (
  commands: readonly CliCommandDefinition[],
  groupSummaries: Readonly<Record<string, string>> | undefined,
): CommandNode => {
  const root: CommandNode = { segment: "", children: new Map() };
  for (const item of commands) {
    let node = root;
    for (const segment of item.path) {
      const current = node.children.get(segment) ?? { segment, children: new Map() };
      node.children.set(segment, current);
      node = current;
    }
    if (node.command) throw new Error(`Duplicate CLI command path: ${item.path.join(" ")}`);
    node.command = item;
  }
  for (const [path, summary] of Object.entries(groupSummaries ?? {})) {
    const segments = path.split(/\s+/).filter(Boolean);
    let node: CommandNode | undefined = root;
    for (const segment of segments) node = node?.children.get(segment);
    if (segments.length === 0 || !node || node.children.size === 0 || node.command) {
      throw new Error(`Unknown generated CLI command group: ${path || "<root>"}`);
    }
    if (!summary.trim()) throw new Error(`CLI command group "${path}" requires a summary.`);
    node.groupSummary = summary.trim();
  }
  return root;
};

const findNode = (root: CommandNode, path: readonly string[]): CommandNode | null => {
  let node = root;
  for (const segment of path) {
    const next = node.children.get(segment);
    if (!next) return null;
    node = next;
  }
  return node;
};

const findCommand = (root: CommandNode, args: readonly string[]) => {
  let node = root;
  let command = root.command;
  let consumed = 0;

  for (let index = 0; index < args.length; index += 1) {
    const next = node.children.get(args[index]!);
    if (!next) break;
    if (index === 0) command = undefined;
    node = next;
    if (node.command) {
      command = node.command;
      consumed = index + 1;
    }
  }

  return command ? { command, rest: args.slice(consumed) } : null;
};

const normalizeHelpRequest = (args: readonly string[], flags: Record<string, CloudCliFlagValue>): string[] | null => {
  if (flags.help === true || flags.h === true) return [...args];
  const last = args.at(-1);
  if (last === "help" || last === "--help" || last === "-h") return args.slice(0, -1);
  return null;
};

const flagNames = (key: string, spec: CliFlagSpec): string[] => {
  if (spec.kind === "input") {
    return [
      spec.name ?? toFlagName(key),
      spec.fileName ?? `${spec.name ?? toFlagName(key)}-file`,
      ...(spec.aliases ?? []),
      ...(spec.fileAliases ?? []),
    ];
  }
  return [spec.name ?? toFlagName(key), ...(spec.aliases ?? [])];
};

const collectBooleanFlags = (commands: readonly CliCommandDefinition[]): readonly string[] => {
  const booleanNames = new Set<string>(["help", "h"]);
  const valueNames = new Set<string>();
  for (const item of commands) {
    for (const [key, spec] of Object.entries(item.flags ?? {})) {
      if (spec.kind === "boolean") {
        for (const name of flagNames(key, spec)) booleanNames.add(name);
      } else {
        for (const name of flagNames(key, spec)) valueNames.add(name);
      }
      if (spec.kind === "input" && spec.stdinName !== false) booleanNames.add(spec.stdinName ?? "stdin");
    }
  }
  for (const name of valueNames) booleanNames.delete(name);
  return [...booleanNames].sort();
};

const getRawFlagValues = (raw: Record<string, CloudCliFlagValue>, names: readonly string[]): CloudCliFlagValue[] => {
  const values: CloudCliFlagValue[] = [];
  for (const name of names) {
    const value = raw[name];
    if (Array.isArray(value)) values.push(...value);
    else if (value !== undefined) values.push(value);
  }
  return values;
};

const requireStringValue = (value: CloudCliFlagValue | undefined, label: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw new Error(`${label} expects a value.`);
};

const parseCommandFlags = (raw: Record<string, CloudCliFlagValue>, specs: CliFlagSpecs | undefined): Record<string, unknown> => {
  const parsed: Record<string, unknown> = {};
  // Global flags survive into command flags (the runner reads them without
  // consuming them), so every global boolean must be tolerated here.
  const allowed = new Set<string>(["json", "jsonl", "help", "h"]);

  for (const [key, spec] of Object.entries(specs ?? {})) {
    for (const name of flagNames(key, spec)) allowed.add(name);
    if (spec.kind === "input" && spec.stdinName !== false) allowed.add(spec.stdinName ?? "stdin");
    parsed[key] = parseFlagValue(key, spec, raw);
  }

  const unknown = Object.keys(raw).filter((name) => !allowed.has(name));
  if (unknown.length > 0)
    throw new Error(`Unknown flag${unknown.length === 1 ? "" : "s"}: ${unknown.map((name) => `--${name}`).join(", ")}`);

  return parsed;
};

const parseFlagValue = (key: string, spec: CliFlagSpec, raw: Record<string, CloudCliFlagValue>): unknown => {
  const label = `--${spec.name ?? toFlagName(key)}`;
  const values = getRawFlagValues(raw, flagNames(key, spec));
  const last = values.at(-1);

  if (spec.kind === "boolean")
    return values.length > 0 ? values.some((value) => value === true || value === "true") : (spec.default ?? false);

  if (spec.kind === "string") {
    const value = requireStringValue(last, label) ?? spec.default;
    if (value === undefined && spec.required) throw new Error(`Missing required flag ${label}.`);
    return value;
  }

  if (spec.kind === "int") {
    const rawValue = requireStringValue(last, label);
    const value = rawValue === undefined ? spec.default : Number.parseInt(rawValue, 10);
    if (value === undefined) {
      if (spec.required) throw new Error(`Missing required flag ${label}.`);
      return undefined;
    }
    if (!Number.isInteger(value)) throw new Error(`${label} must be an integer.`);
    if (spec.min !== undefined && value < spec.min) throw new Error(`${label} must be at least ${spec.min}.`);
    if (spec.max !== undefined && value > spec.max) throw new Error(`${label} must be at most ${spec.max}.`);
    return value;
  }

  if (spec.kind === "enum") {
    const value = requireStringValue(last, label) ?? spec.default;
    if (value === undefined) {
      if (spec.required) throw new Error(`Missing required flag ${label}.`);
      return undefined;
    }
    if (!spec.values.includes(value)) throw new Error(`${label} must be one of: ${spec.values.join(", ")}.`);
    return value;
  }

  if (spec.kind === "stringList") {
    const separator = spec.separator ?? ",";
    const items = values.flatMap((value) => {
      if (typeof value !== "string") throw new Error(`${label} expects a value.`);
      return value
        .split(separator)
        .map((item) => item.trim())
        .filter(Boolean);
    });
    return items.length > 0 ? items : [...(spec.default ?? [])];
  }

  const valueFlagNames = [spec.name ?? toFlagName(key), ...(spec.aliases ?? [])];
  const fileFlagNames = [spec.fileName ?? `${spec.name ?? toFlagName(key)}-file`, ...(spec.fileAliases ?? [])];
  const value = requireStringValue(getRawFlagValues(raw, valueFlagNames).at(-1), `--${valueFlagNames[0]}`);
  const file = requireStringValue(getRawFlagValues(raw, fileFlagNames).at(-1), `--${fileFlagNames[0]}`);
  const stdinName = spec.stdinName === false ? null : (spec.stdinName ?? "stdin");
  const stdin = stdinName ? raw[stdinName] === true : false;
  const sourceCount = [value !== undefined, file !== undefined, stdin].filter(Boolean).length;
  if (sourceCount > 1)
    throw new Error(`Pass only one of --${valueFlagNames[0]}, --${fileFlagNames[0]}${stdinName ? `, or --${stdinName}` : ""}.`);
  if (sourceCount === 0 && spec.required) throw new Error(`Missing required input ${label}.`);
  return {
    source: value !== undefined ? "value" : file !== undefined ? "file" : stdin ? "stdin" : null,
    value,
    file,
    provided: sourceCount > 0,
  } satisfies CliInputFlagValue;
};

const parseCommandArgs = (rawArgs: readonly string[], specs: CliArgSpecs | undefined): Record<string, unknown> => {
  const parsed: Record<string, unknown> = {};
  let index = 0;

  for (const [key, spec] of Object.entries(specs ?? {})) {
    if (spec.kind === "rest") {
      const rest = rawArgs.slice(index);
      if (spec.required && rest.length === 0) throw new Error(`Missing ${spec.valueLabel ?? key}.`);
      parsed[key] = rest;
      index = rawArgs.length;
      break;
    }

    const value = rawArgs[index];
    if (value === undefined) {
      if (spec.kind === "required") throw new Error(`Missing ${spec.valueLabel ?? key}.`);
      parsed[key] = undefined;
      continue;
    }
    parsed[key] = value;
    index += 1;
  }

  if (index < rawArgs.length) throw new Error(`Unexpected argument: ${rawArgs[index]}.`);
  return parsed;
};

const renderHelp = (config: CliCommandsConfig, root: CommandNode, path: readonly string[]): string => {
  const node = findNode(root, path);
  if (!node) return `Unknown ${config.name} command "${path.join(" ")}".`;
  if (node.command && node.children.size === 0) return renderCommandHelp(config, node.command);
  return renderSubtreeHelp(config, path, node);
};

const renderSubtreeHelp = (config: CliCommandsConfig, path: readonly string[], node: CommandNode): string => {
  const prefix = ["cld", config.name, ...path].join(" ");
  const commands = [...node.children.values()]
    .sort((a, b) => a.segment.localeCompare(b.segment))
    .map((child) => {
      const summary = child.command?.summary ?? child.groupSummary ?? "Commands";
      return `  ${child.segment.padEnd(14)} ${summary}`.trimEnd();
    })
    .join("\n");

  const sections = [
    prefix,
    "",
    path.length === 0 ? config.summary : (node.command?.summary ?? node.groupSummary ?? "Commands"),
    "",
    "Usage:",
    ...(node.command ? [`  ${renderUsage(config, node.command)}`] : []),
    `  ${prefix} <command> [options]`,
    `  ${prefix} help`,
    "",
    "Commands:",
    commands || "  (none)",
  ];
  if (node.command) {
    const argsHelp = renderArgsHelp(node.command.args);
    if (argsHelp) sections.push("", "Arguments:", argsHelp);
    const flagsHelp = renderFlagsHelp(node.command.flags);
    if (flagsHelp) sections.push("", "Flags:", flagsHelp);
    if (node.command.examples?.length) sections.push("", "Examples:", ...node.command.examples.map((example) => `  ${example}`));
    if (node.command.description) sections.push("", node.command.description);
  }
  return sections.join("\n");
};

const firstCommand = (node: CommandNode): CliCommandDefinition | undefined => {
  if (node.command) return node.command;
  for (const child of node.children.values()) {
    const found = firstCommand(child);
    if (found) return found;
  }
  return undefined;
};

const renderCommandHelp = (config: CliCommandsConfig, item: CliCommandDefinition): string => {
  const usage = renderUsage(config, item);
  const heading = ["cld", config.name, ...item.path].join(" ");
  const sections = [heading, "", item.summary, "", "Usage:", `  ${usage}`];
  const argsHelp = renderArgsHelp(item.args);
  if (argsHelp) sections.push("", "Arguments:", argsHelp);
  const flagsHelp = renderFlagsHelp(item.flags);
  if (flagsHelp) sections.push("", "Flags:", flagsHelp);
  if (item.examples?.length) sections.push("", "Examples:", ...item.examples.map((example) => `  ${example}`));
  if (item.description) sections.push("", item.description);
  return sections.join("\n");
};

const renderUsage = (config: CliCommandsConfig, item: CliCommandDefinition): string => {
  const args = Object.entries(item.args ?? {}).map(([key, spec]) => {
    const label = spec.valueLabel ?? key;
    if (spec.kind === "optional") return `[<${label}>]`;
    if (spec.kind === "rest") return spec.required ? `<${label}...>` : `[<${label}...>]`;
    return `<${label}>`;
  });
  return ["cld", config.name, ...item.path, ...args, "[options]"].join(" ");
};

const renderArgsHelp = (specs: CliArgSpecs | undefined): string => {
  const rows = Object.entries(specs ?? {});
  if (rows.length === 0) return "";
  return rows.map(([key, spec]) => `  <${spec.valueLabel ?? key}>${spec.description ? `  ${spec.description}` : ""}`).join("\n");
};

const renderFlagsHelp = (specs: CliFlagSpecs | undefined): string => {
  const rows = Object.entries(specs ?? {});
  if (rows.length === 0) return "";
  return rows.map(([key, spec]) => `  ${renderFlagUsage(key, spec).padEnd(32)} ${renderFlagDescription(spec)}`.trimEnd()).join("\n");
};

const renderFlagUsage = (key: string, spec: CliFlagSpec): string => {
  const name = spec.name ?? toFlagName(key);
  const aliases = spec.aliases?.map((alias) => `${alias.length === 1 ? "-" : "--"}${alias}`).join(", ");
  const suffix =
    spec.kind === "boolean"
      ? ""
      : spec.kind === "input"
        ? ` <${spec.valueLabel ?? "value"}>|--${spec.fileName ?? `${name}-file`} <path>${spec.stdinName === false ? "" : `|--${spec.stdinName ?? "stdin"}`}`
        : ` <${spec.valueLabel ?? "value"}>`;
  return [`--${name}${suffix}`, aliases].filter(Boolean).join(", ");
};

const renderFlagDescription = (spec: CliFlagSpec): string => {
  const parts = [spec.description];
  if ("required" in spec && spec.required) parts.push("Required.");
  if ("default" in spec && spec.default !== undefined)
    parts.push(`Default: ${Array.isArray(spec.default) ? spec.default.join(",") : spec.default}.`);
  if (spec.kind === "enum") parts.push(`Values: ${spec.values.join(", ")}.`);
  return parts.filter(Boolean).join(" ");
};
