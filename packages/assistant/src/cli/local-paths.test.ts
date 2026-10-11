import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { completeInteractiveLine, INTERACTIVE_COMMANDS } from "./interactive";
import { classifyLocalPath, completeLocalPath, extractMessageAttachments } from "./local-paths";

let root: string;
let workspace: string;
let home: string;
let previousXdg: string | undefined;
let previousConfig: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "assistant-paths-"));
  workspace = join(root, "workspace");
  home = join(root, "home");
  mkdirSync(workspace);
  mkdirSync(home);
  previousXdg = process.env.XDG_CONFIG_HOME;
  previousConfig = process.env.CLD_CONFIG;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  delete process.env.CLD_CONFIG;
});
afterEach(() => {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  if (previousConfig === undefined) delete process.env.CLD_CONFIG;
  else process.env.CLD_CONFIG = previousConfig;
  rmSync(root, { recursive: true, force: true });
});
const file = (path: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "test");
  return path;
};

describe("local path completion", () => {
  test("keeps @, finishes directories with /, and hides dot entries", () => {
    file(join(workspace, "alpha.txt"));
    file(join(workspace, ".hidden"));
    mkdirSync(join(workspace, "assets"));
    expect(completeLocalPath("@a", workspace)).toEqual(["@alpha.txt", "@assets/"]);
    expect(completeLocalPath("@", workspace)).toEqual(["@alpha.txt", "@assets/"]);
    expect(completeLocalPath("@.", workspace)).toEqual(["@.hidden"]);
    expect(completeLocalPath("@missing/", workspace)).toEqual([]);
    expect(completeLocalPath(`@${workspace}/a`, workspace)).toEqual([`@${workspace}/alpha.txt`, `@${workspace}/assets/`]);
    const homePrefix = `@~/${relative(homedir(), workspace)}/a`;
    expect(completeLocalPath(homePrefix, workspace)).toEqual([`${homePrefix}lpha.txt`, `${homePrefix}ssets/`]);
  });

  test("commands and /attach use the same table and path completer", () => {
    file(join(workspace, "alpha.txt"));
    expect(completeInteractiveLine("/", workspace)).toEqual([INTERACTIVE_COMMANDS.map((entry) => entry.name), "/"]);
    expect(completeInteractiveLine("/mo", workspace)).toEqual([["/model"], "/mo"]);
    expect(completeInteractiveLine("read @a", workspace)).toEqual([["@alpha.txt"], "@a"]);
    expect(completeInteractiveLine("/attach a", workspace)).toEqual([["alpha.txt"], "a"]);
    expect(completeInteractiveLine("plain text", workspace)).toEqual([[], "text"]);
  });

  test("escaped spaced mentions complete and round-trip through extraction", () => {
    const path = file(join(workspace, "quarterly report.pdf"));
    const candidates = ["@quarterly\\ report.pdf"];
    expect(completeLocalPath("@quar", workspace)).toEqual(candidates);
    expect(completeLocalPath("@quarterly\\ re", workspace)).toEqual(candidates);
    expect(completeInteractiveLine("Summarize @quarterly\\ re", workspace)).toEqual([candidates, "@quarterly\\ re"]);
    expect(extractMessageAttachments("Summarize @quarterly\\ report.pdf", workspace)).toEqual([path]);
    expect(extractMessageAttachments(`Summarize ${candidates[0]}`, workspace)).toEqual([path]);
    expect(completeInteractiveLine("/attach quar", workspace)).toEqual([["quarterly report.pdf"], "quar"]);
  });

  test("directory symlinks complete with / and unreadable targets do not throw", () => {
    mkdirSync(join(workspace, "directory"));
    symlinkSync(join(workspace, "directory"), join(workspace, "alias"));
    symlinkSync(join(workspace, "missing"), join(workspace, "dangling"));
    expect(completeLocalPath("@alias", workspace)).toEqual(["@alias/"]);
    expect(completeLocalPath("@dangling", workspace)).toEqual(["@dangling"]);
    file(join(workspace, "file"));
    expect(completeLocalPath("@file/", workspace)).toEqual([]);
  });

  test("bounds results to 200 candidates", () => {
    for (let index = 0; index < 205; index++) file(join(workspace, `f${index}`));
    expect(completeLocalPath("@", workspace)).toHaveLength(200);
  });
});

describe("local access classification", () => {
  test("checks workspace boundaries and symlink targets, including future files", () => {
    const outside = file(join(root, "outside"));
    symlinkSync(outside, join(workspace, "linked"));
    symlinkSync(root, join(workspace, "external-directory"));
    for (const path of [outside, join(workspace, "linked"), join(workspace, "external-directory/new.txt")])
      expect(classifyLocalPath(path, { workspace, home })).toEqual({ access: "ask", reason: "outside" });
    expect(classifyLocalPath("new.txt", { workspace, home })).toEqual({ access: "free" });
    expect(classifyLocalPath("~/new.txt", { workspace, home })).toEqual({ access: "ask", reason: "outside" });
    expect(classifyLocalPath(join(`${workspace}-other`, "x"), { workspace, home })).toEqual({ access: "ask", reason: "outside" });
  });

  test.each([
    ".env",
    ".env.local",
    "cert.pem",
    "secret.key",
    "cert.p12",
    "id_rsa.pub",
    "id_ed25519",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    ".ssh/x",
    ".gnupg/x",
    ".aws/x",
    ".git/hooks/x",
  ])("asks for protected %s inside the workspace", (path) => {
    expect(classifyLocalPath(path, { workspace, home })).toEqual({ access: "ask", reason: "protected" });
  });

  test("asks for a protected symlink name even when its target is ordinary", () => {
    const target = file(join(workspace, "secrets.txt"));
    const alias = join(workspace, ".env");
    symlinkSync(target, alias);
    expect(classifyLocalPath(alias, { workspace, home })).toEqual({ access: "ask", reason: "protected" });
    expect(extractMessageAttachments("Read @.env @secrets.txt", workspace)).toEqual([alias]);
  });

  test("home, root, and a home ancestor never grant free access", () => {
    for (const directory of [home, root, "/"])
      expect(classifyLocalPath(join(directory, "new.txt"), { workspace: directory, home })).toEqual({ access: "ask", reason: "home" });
  });

  test("blocks the cld config directory, explicit file, and aliases to them", () => {
    const config = file(join(root, "config/cloud/cld/config.json"));
    symlinkSync(config, join(workspace, "alias"));
    for (const path of [config, dirname(config), join(dirname(config), "plugins/new"), join(workspace, "alias")])
      expect(classifyLocalPath(path, { workspace, home })).toEqual({ access: "blocked", reason: "cld-config" });
    process.env.CLD_CONFIG = file(join(workspace, "custom.json"));
    expect(classifyLocalPath(process.env.CLD_CONFIG, { workspace, home })).toEqual({ access: "blocked", reason: "cld-config" });
    delete process.env.XDG_CONFIG_HOME;
    expect(classifyLocalPath(join(home, ".config/cloud/cld/future.json"), { workspace, home })).toEqual({
      access: "blocked",
      reason: "cld-config",
    });
  });
});

describe("message file mentions", () => {
  test("strips punctuation only after a missing literal path and deduplicates real files", () => {
    const plain = file(join(workspace, "a.txt"));
    const punctuated = file(join(workspace, "b.txt,"));
    symlinkSync(plain, join(workspace, "alias"));
    mkdirSync(join(workspace, "directory"));
    const message = "read @a.txt, @a.txt.;:!?) @alias @b.txt, @directory @team name@example.org";
    expect(extractMessageAttachments(message, workspace)).toEqual([plain, punctuated]);
  });
});
