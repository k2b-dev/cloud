import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CloudAiLocalDownloadOutputSchema,
  CloudAiLocalListOutputSchema,
  CloudAiLocalMoveOutputSchema,
  CloudAiLocalReadOutputSchema,
  CloudAiLocalUploadOutputSchema,
  CloudAiLocalWriteOutputSchema,
} from "@k2b/cloud/ai/browser";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { createLocalSessionFolder, runLocalTool } from "./local-tools";

let root: string;
let workspace: string;
let session: ReturnType<typeof createLocalSessionFolder>;
let approve: boolean;
let questions: Array<{ lines: string[]; question: string }>;
let beforeAnswer: (() => Promise<void>) | undefined;
let beforeUpload: ((signal?: AbortSignal | null) => Promise<void>) | undefined;
let deadlineMs: number | undefined;
let uploads: Array<{ name: string; directory: FormDataEntryValue | null }>;
let response: () => Response;
let mode: "ask" | "off";
let previousConfig: string | undefined;
const ctx: CloudCliContext = {
  args: [],
  flags: {},
  options: { server: "https://example.test", profile: "test", token: "test", output: "text" },
  getDefault: async () => undefined,
  setDefault: async () => {},
  createApiClient: () => {
    throw new Error("Unused");
  },
  fetch: async (_path, init) => {
    if (init?.body instanceof FormData) {
      const file = init.body.get("file");
      if (!(file instanceof File)) throw new Error("Expected file");
      await beforeUpload?.(init.signal);
      uploads.push({ name: file.name, directory: init.body.get("directory") });
      return Response.json({ file: { path: `/returned/${file.name}`, mediaType: file.type, size: file.size, version: 1 } });
    }
    return response();
  },
  readJson: (response) => response.json(),
  print: () => {},
  error: () => {},
  write: async () => {},
  json: () => {},
  jsonLine: () => {},
  table: () => {},
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cld-tools-test-"));
  workspace = join(root, "workspace");
  await mkdir(workspace);
  session = createLocalSessionFolder();
  approve = true;
  questions = [];
  uploads = [];
  beforeAnswer = undefined;
  beforeUpload = undefined;
  deadlineMs = undefined;
  mode = "ask";
  response = () => new Response("new content", { headers: { "content-length": "11" } });
  previousConfig = process.env.CLD_CONFIG;
  process.env.CLD_CONFIG = join(workspace, "cld.json");
});
afterEach(async () => {
  await session.close();
  await rm(root, { recursive: true, force: true });
  if (previousConfig === undefined) delete process.env.CLD_CONFIG;
  else process.env.CLD_CONFIG = previousConfig;
});
const run = (name: string, args: unknown, freeReadRoots: string[] = [], signal = new AbortController().signal) =>
  runLocalTool(
    { name, args, callId: "call" },
    {
      ctx,
      workspace,
      conversationId: "chat",
      freeReadRoots,
      skills: [],
      mode,
      sessionFolder: session,
      printBash: () => {},
      ask: async (lines, question) => {
        questions.push({ lines, question });
        await beforeAnswer?.();
        return approve;
      },
    },
    signal,
    deadlineMs,
  );

test.each(["subfolder/AGENTS.md", ".agents/skills/x/SKILL.md", "subfolder/agents.MD", ".AGENTS/skills/x/SKILL.md"])(
  "creating instruction path %s asks once and can be declined",
  async (path) => {
    approve = false;
    expect(await run("local_write", { path, mode: "create", content: "instructions" })).toEqual({
      status: "denied",
      error: "The user declined.",
    });
    expect(questions).toEqual([{ lines: [], question: `Write ${path}? It becomes instructions for the assistant.` }]);
    expect(await Bun.file(join(workspace, path)).exists()).toBeFalse();
  },
);

test("instruction aliases ask on write and download; reading and uploading instructions stay free", async () => {
  await writeFile(join(workspace, "AGENTS.md"), "old");
  await symlink(join(workspace, "AGENTS.md"), join(workspace, "alias.md"));
  approve = false;
  for (const path of ["AGENTS.md", "alias.md"])
    expect(await run("local_write", { path, mode: "replace", content: "new" })).toMatchObject({ status: "denied" });
  expect(questions.map((entry) => entry.lines)).toEqual([
    ["AGENTS.md: becomes instructions for the assistant"],
    ["alias.md: becomes instructions for the assistant"],
  ]);
  questions = [];
  expect(await run("local_download", { path: "/chat.txt", to: "sub/AGENTS.md" })).toMatchObject({ status: "denied" });
  expect(questions).toEqual([{ lines: [], question: "Save sub/AGENTS.md? It becomes instructions for the assistant." }]);
  questions = [];
  expect(await run("local_read", { path: "AGENTS.md" })).toMatchObject({ status: "completed", kind: "text" });
  expect(await run("local_upload", { paths: ["AGENTS.md"] })).toMatchObject({ status: "completed", failed: [] });
  expect(questions).toEqual([]);
});

test("move review marks instruction targets", async () => {
  await writeFile(join(workspace, "a.md"), "instructions");
  approve = false;
  expect(await run("local_move", { moves: [{ from: "a.md", to: "sub/AGENTS.md" }] })).toMatchObject({ status: "denied" });
  expect(questions[0]?.lines).toContain("  a.md → sub/AGENTS.md (becomes instructions for the assistant)");
});

test("instruction segments in the given path still ask after normalization", async () => {
  approve = false;
  expect(await run("local_write", { path: "sub/.agents/../notes.md", content: "instructions" })).toMatchObject({ status: "denied" });
  expect(questions).toEqual([{ lines: [], question: "Write sub/notes.md? It becomes instructions for the assistant." }]);
});

test.each(["local_move", "local_write"])("%s gives work a fresh deadline after a slow approval", async (name) => {
  await writeFile(join(workspace, "old.txt"), "old");
  deadlineMs = 50;
  beforeAnswer = () => Bun.sleep(100);
  const args =
    name === "local_move" ? { moves: [{ from: "old.txt", to: "new.txt" }] } : { path: "old.txt", mode: "replace", content: "new" };
  expect(await run(name, args)).toMatchObject({ status: "completed" });
  expect(questions).toHaveLength(1);
  expect(await readFile(join(workspace, name === "local_move" ? "new.txt" : "old.txt"), "utf8")).toBe(
    name === "local_move" ? "old" : "new",
  );
});

test("upload deadline preserves completed files and reports the current and remaining files", async () => {
  for (const path of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(workspace, path), path);
  deadlineMs = 50;
  let count = 0;
  beforeUpload = async (signal) => {
    if (++count === 2) {
      await Bun.sleep(100);
      signal?.throwIfAborted();
    }
  };
  expect(CloudAiLocalUploadOutputSchema.parse(await run("local_upload", { paths: ["a.txt", "b.txt", "c.txt"] }))).toMatchObject({
    status: "completed",
    files: [{ path: "a.txt", chatPath: "/returned/a.txt" }],
    failed: [
      { path: "b.txt", error: "The operation timed out." },
      { path: "c.txt", error: "The operation timed out." },
    ],
  });
  expect(count).toBe(2);
});

test("text reads use content for application MIME types and accept Latin-1", async () => {
  for (const path of ["config.toml", "script.sh"]) {
    await writeFile(join(workspace, path), "plain text");
    expect(await run("local_read", { path })).toMatchObject({ status: "completed", kind: "text", content: "1\tplain text\n" });
  }
  await writeFile(join(workspace, "latin.csv"), Buffer.from([0xe4, 0x0a]));
  expect(await run("local_read", { path: "latin.csv" })).toMatchObject({ status: "completed", kind: "text" });
  await writeFile(join(workspace, "nul.toml"), "text\0binary");
  expect(await run("local_read", { path: "nul.toml" })).toMatchObject({
    status: "failed",
    error: "Binary file. Upload it with local_upload if a Cloud tool can read it.",
  });
});

test.each(["project", "skills"])("derived upload folders avoid the reserved %s mount", async (folder) => {
  await mkdir(join(workspace, folder, "nested"), { recursive: true });
  await writeFile(join(workspace, folder, "Scan.pdf"), "%PDF");
  await writeFile(join(workspace, folder, "nested/notes.txt"), "notes");
  expect(await run("local_read", { path: `${folder}/Scan.pdf` })).toMatchObject({ status: "completed", kind: "uploaded" });
  await run("local_upload", { paths: [`${folder}/nested/notes.txt`] });
  expect(uploads.map((file) => file.directory)).toEqual([`/local/${folder}`, `/local/${folder}/nested`]);
  await run("local_upload", { paths: [`${folder}/Scan.pdf`], directory: "/receipts" });
  expect(uploads.at(-1)?.directory).toBe("/receipts");
});

test("lists case-insensitive nested globs, pages in order, and never walks protected or symlink folders", async () => {
  await mkdir(join(workspace, "docs"));
  await mkdir(join(workspace, ".git"));
  await writeFile(join(workspace, "docs/A.PDF"), "a");
  await writeFile(join(workspace, "b.pdf"), "b");
  await writeFile(join(workspace, ".git/secret.pdf"), "secret");
  await symlink(join(workspace, "docs"), join(workspace, "alias"));
  const first = CloudAiLocalListOutputSchema.parse(await run("local_list", { pattern: "**/*.PDF", limit: 1 }));
  expect(first).toMatchObject({ status: "completed", entries: [{ path: "b.pdf" }], nextAfter: "b.pdf" });
  expect(await run("local_list", { pattern: "**/*.pdf", after: "b.pdf" })).toMatchObject({
    entries: [{ path: "docs/A.PDF" }],
    nextAfter: null,
  });
  expect(questions).toEqual([]);
});

test("streams line pages, byte budgets, offsets, and oversized lines", async () => {
  await writeFile(join(workspace, "notes.md"), "one\ntwo\nthree\n");
  expect(CloudAiLocalReadOutputSchema.parse(await run("local_read", { path: "notes.md", maxBytes: 8 }))).toEqual({
    status: "completed",
    kind: "text",
    path: "notes.md",
    content: "1\tone\n2\ttwo\n",
    firstLine: 1,
    lastLine: 2,
    totalBytes: 14,
    nextOffset: 3,
  });
  expect(await run("local_read", { path: "notes.md", offset: 3 })).toMatchObject({ content: "3\tthree\n", nextOffset: null });
  await writeFile(join(workspace, "long.txt"), `${"x".repeat(1024 * 1024)}\nend`);
  expect(await run("local_read", { path: "long.txt", maxBytes: 4 })).toMatchObject({
    content: "1\txxxx [line shortened]\n",
    nextOffset: 2,
  });
});

test("read-only roots are free by realpath, while config is always denied", async () => {
  const outside = join(root, "skill");
  await mkdir(outside);
  await writeFile(join(outside, "guide.md"), "guide");
  await symlink(outside, join(workspace, "references"));
  expect(await run("local_read", { path: "references/guide.md" }, [outside])).toMatchObject({ status: "completed" });
  await writeFile(join(workspace, "cld.json"), "secret");
  expect(await run("local_read", { path: "cld.json" }, [workspace])).toEqual({
    status: "denied",
    error: "cld's configuration is never available to the assistant.",
  });
  expect(questions).toEqual([]);
});

test("a free read root never frees a file that may hold secrets", async () => {
  const outside = join(root, "skill");
  await mkdir(outside);
  await writeFile(join(outside, ".env"), "TOKEN=1");
  approve = false;
  expect(await run("local_read", { path: join(outside, ".env") }, [outside])).toEqual({ status: "denied", error: "The user declined." });
  expect(questions).toEqual([{ lines: [], question: `Read ${join(outside, ".env")}? It may contain secrets.` }]);
});

test("a protected alias still asks; declining reads returns denied", async () => {
  await writeFile(join(workspace, "ordinary"), "secret");
  await symlink(join(workspace, "ordinary"), join(workspace, ".env"));
  approve = false;
  expect(await run("local_read", { path: ".env" })).toEqual({ status: "denied", error: "The user declined." });
  expect(questions).toEqual([{ lines: [], question: "Read .env? It may contain secrets." }]);
});

test("document reads upload and binary reads fail without uploading", async () => {
  await mkdir(join(workspace, "2026-09"));
  await writeFile(join(workspace, "2026-09/Scan.pdf"), "%PDF");
  expect(CloudAiLocalReadOutputSchema.parse(await run("local_read", { path: "2026-09/Scan.pdf" }))).toMatchObject({
    kind: "uploaded",
    chatPath: "/returned/Scan.pdf",
  });
  expect(uploads).toEqual([{ name: "Scan.pdf", directory: "/2026-09" }]);
  await writeFile(join(workspace, "data.unknown"), Buffer.from([1, 0, 2]));
  expect(await run("local_read", { path: "data.unknown" })).toEqual({
    status: "failed",
    error: "Binary file. Upload it with local_upload if a Cloud tool can read it.",
  });
});

test("uploads ask once for the risky subset and preserve free files on denial", async () => {
  await writeFile(join(workspace, "free.txt"), "free");
  await writeFile(join(workspace, ".env"), "secret");
  const outside = join(root, "outside.txt");
  await writeFile(outside, "outside");
  approve = false;
  const result = CloudAiLocalUploadOutputSchema.parse(await run("local_upload", { paths: ["free.txt", ".env", outside, "."] }));
  expect(result).toMatchObject({
    status: "completed",
    files: [{ path: "free.txt", chatPath: "/returned/free.txt" }],
    failed: expect.arrayContaining([
      { path: ".env", error: "The user declined." },
      { path: outside, error: "The user declined." },
    ]),
  });
  expect(questions).toHaveLength(1);
  expect(questions[0]).toEqual({
    lines: ["  .env (may contain secrets)", `  ${outside} (outside ${workspace})`],
    question: "Upload these files?",
  });
  expect(uploads).toHaveLength(1);
});

test("explicit upload directory applies to each file", async () => {
  await writeFile(join(workspace, "a.txt"), "a");
  await writeFile(join(workspace, "b.txt"), "b");
  await run("local_upload", { paths: ["a.txt", "b.txt"], directory: "/receipts" });
  expect(uploads.map((file) => file.directory)).toEqual(["/receipts", "/receipts"]);
});

test("writes create freely and ask before append or atomic replace, preserving permissions", async () => {
  expect(CloudAiLocalWriteOutputSchema.parse(await run("local_write", { path: "notes/a.md", content: "a" }))).toMatchObject({
    status: "completed",
    size: 1,
  });
  expect(questions).toEqual([]);
  expect(await run("local_write", { path: "notes/a.md", content: "b" })).toEqual({
    status: "failed",
    error: "notes/a.md exists. Use append or replace.",
  });
  expect(await run("local_write", { path: "notes/missing.md", mode: "append", content: "b" })).toEqual({
    status: "failed",
    error: "notes/missing.md does not exist. Use create.",
  });
  await chmod(join(workspace, "notes/a.md"), 0o640);
  await run("local_write", { path: "notes/a.md", mode: "append", content: "b" });
  expect(await readFile(join(workspace, "notes/a.md"), "utf8")).toBe("ab");
  await run("local_write", { path: "notes/a.md", mode: "replace", content: "new" });
  expect(await readFile(join(workspace, "notes/a.md"), "utf8")).toBe("new");
  expect((await stat(join(workspace, "notes/a.md"))).mode & 0o777).toBe(0o640);
  expect(questions.map((entry) => entry.question)).toEqual([
    expect.stringMatching(/^Append 1 B to notes\/a.md/),
    expect.stringMatching(/^Replace notes\/a.md.*with 3 B\?$/),
  ]);
});

test("replacement notices a file changed while the question was open", async () => {
  const path = join(workspace, "notes.md");
  await writeFile(path, "old");
  beforeAnswer = () => writeFile(path, "changed by another writer");
  expect(await run("local_write", { path: "notes.md", mode: "replace", content: "new" })).toMatchObject({
    status: "failed",
    error: "notes.md changed after review. Try again.",
  });
  expect(await readFile(path, "utf8")).toBe("changed by another writer");
  expect(await readdir(workspace)).toEqual(["notes.md"]);
});

test("exclusive download never overwrites a target that appears after permission", async () => {
  const outside = join(root, "out.txt");
  beforeAnswer = () => writeFile(outside, "appeared");
  const result = CloudAiLocalDownloadOutputSchema.parse(await run("local_download", { path: "/chat.txt", to: outside }));
  expect(result.status).toBe("failed");
  expect(await readFile(outside, "utf8")).toBe("appeared");
});

test("download streams into new subfolders, refuses an existing target, and replaces only after review", async () => {
  expect(await run("local_download", { path: "/chat.txt", to: "reports/report.txt" })).toMatchObject({
    status: "completed",
    size: 11,
    replaced: false,
  });
  expect(questions).toEqual([]);
  expect(await run("local_download", { path: "/chat.txt", to: "reports/report.txt" })).toEqual({
    status: "failed",
    error: "reports/report.txt exists. Choose another name, or use replace: true after the user agrees.",
  });
  response = () => new Response("other", { headers: { "content-length": "5" } });
  approve = false;
  expect(await run("local_download", { path: "/chat.txt", to: "reports/report.txt", replace: true })).toEqual({
    status: "denied",
    error: "The user declined.",
  });
  expect(await readFile(join(workspace, "reports/report.txt"), "utf8")).toBe("new content");
  approve = true;
  expect(await run("local_download", { path: "/chat.txt", to: "reports/report.txt", replace: true })).toMatchObject({
    status: "completed",
    replaced: true,
    size: 5,
  });
});

test("failed download removes its temp file and keeps the reviewed original", async () => {
  await writeFile(join(workspace, "old.txt"), "old");
  response = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("part"));
          controller.error(new Error("lost connection"));
        },
      }),
    );
  expect(await run("local_download", { path: "/file", to: "old.txt", replace: true })).toMatchObject({ status: "failed" });
  expect(await readFile(join(workspace, "old.txt"), "utf8")).toBe("old");
});

test("move prechecks all conflicts before asking, including another source and duplicate destinations", async () => {
  await writeFile(join(workspace, "a"), "a");
  await writeFile(join(workspace, "b"), "b");
  const result = CloudAiLocalMoveOutputSchema.parse(
    await run("local_move", {
      moves: [
        { from: "a", to: "b" },
        { from: "b", to: "b" },
      ],
    }),
  );
  expect(result).toMatchObject({ status: "failed", moved: [] });
  expect(result.conflicts).toHaveLength(2);
  expect(questions).toEqual([]);
  expect(
    await run("local_move", {
      moves: [
        { from: "a", to: "c" },
        { from: "b", to: "c" },
      ],
    }),
  ).toMatchObject({ status: "failed", moved: [], conflicts: [{ to: "c", reason: "Duplicate target." }] });
});

test("moves ask once with aligned arrows and create target folders", async () => {
  await writeFile(join(workspace, "a"), "a");
  await writeFile(join(workspace, "long"), "b");
  const result = await run("local_move", {
    moves: [
      { from: "a", to: "sorted/a" },
      { from: "long", to: "sorted/b" },
    ],
  });
  expect(result).toEqual({
    status: "completed",
    moved: [
      { from: "a", to: "sorted/a" },
      { from: "long", to: "sorted/b" },
    ],
    conflicts: [],
  });
  expect(questions).toEqual([{ lines: [`Move in ${workspace} (2 files):`, "  a    → sorted/a", "  long → sorted/b"], question: "Move?" }]);
});

test("a target appearing after review stops a move batch with partial progress", async () => {
  await writeFile(join(workspace, "a"), "a");
  await writeFile(join(workspace, "b"), "b");
  beforeAnswer = () => writeFile(join(workspace, "target-b"), "appeared");
  expect(
    await run("local_move", {
      moves: [
        { from: "a", to: "target-a" },
        { from: "b", to: "target-b" },
      ],
    }),
  ).toMatchObject({
    status: "failed",
    moved: [{ from: "a", to: "target-a" }],
    conflicts: [{ to: "target-b", reason: "Target appeared after review." }],
  });
  expect(await readFile(join(workspace, "b"), "utf8")).toBe("b");
  expect(await readFile(join(workspace, "target-b"), "utf8")).toBe("appeared");
});

test("moves refuse outside symlink targets without asking", async () => {
  await writeFile(join(root, "outside"), "a");
  await symlink(join(root, "outside"), join(workspace, "alias"));
  expect(await run("local_move", { moves: [{ from: "alias", to: "local" }] })).toEqual({
    status: "denied",
    moved: [],
    conflicts: [],
    error: `Moves stay inside ${workspace}.`,
  });
  expect(questions).toEqual([]);
});

test("large Bash output remains in a private session file, which is a free read root and is removed on close", async () => {
  const result: unknown = await run("local_bash", { command: "printf '%070000d' 0" });
  if (!result || typeof result !== "object" || !("outputPath" in result) || typeof result.outputPath !== "string")
    throw new Error("Expected saved output");
  expect(result).toMatchObject({ stdout: expect.stringContaining("bytes omitted; full output:") });
  expect((await stat(result.outputPath)).mode & 0o777).toBe(0o600);
  expect((await stat(await session.get())).mode & 0o777).toBe(0o700);
  expect(await run("local_read", { path: result.outputPath, maxBytes: 1024 })).toMatchObject({ status: "completed" });
  expect(questions).toHaveLength(1);
  await session.close();
  expect(await Bun.file(result.outputPath).exists()).toBeFalse();
});

test.each(["local_bash", "local_list", "local_read", "local_upload", "local_download", "local_write", "local_move", "load_local_skill"])(
  "off denies %s before argument parsing or asking",
  async (name) => {
    mode = "off";
    expect(await run(name, {})).toMatchObject({ status: "denied" });
    expect(questions).toEqual([]);
  },
);

test("an aborted walk returns a failure without accessing files or asking", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Stopped"));
  expect(await run("local_list", {}, [], controller.signal)).toEqual({ status: "failed", error: "Stopped" });
});

test("load_local_skill returns the body, real folder, and bounded paths without reading supporting files", async () => {
  const directory = join(workspace, "skill");
  await mkdir(directory);
  await writeFile(join(directory, "SKILL.md"), "---\nname: finance\ndescription: Receipts\n---\nReconcile receipts.");
  await writeFile(join(directory, ".hidden"), "secret");
  for (let i = 0; i < 55; i++) await writeFile(join(directory, `reference-${String(i).padStart(2, "0")}.md`), "reference");
  const skill = {
    name: "finance",
    description: "Receipts",
    scope: "project" as const,
    directory,
    path: join(directory, "SKILL.md"),
    manualOnly: false,
  };
  const options = {
    ctx,
    workspace,
    conversationId: "chat",
    freeReadRoots: [directory],
    skills: [skill],
    mode: "ask" as const,
    sessionFolder: session,
    printBash: () => {},
    ask: async () => {
      throw new Error("Must not ask");
    },
  };
  const result = await runLocalTool(
    { name: "load_local_skill", args: { name: "finance" }, callId: "call" },
    options,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    status: "completed",
    directory,
    instructions: "Reconcile receipts.",
    files: Array.from({ length: 50 }, (_, i) => `reference-${String(i).padStart(2, "0")}.md`),
  });
  expect(
    await runLocalTool(
      { name: "load_local_skill", args: { name: "finance" }, callId: "call" },
      { ...options, skills: [{ ...skill, manualOnly: true }] },
      new AbortController().signal,
    ),
  ).toEqual({ status: "failed", error: "This Skill starts only when the user selects it with /finance." });
  expect(
    await runLocalTool({ name: "load_local_skill", args: { name: "unknown" }, callId: "call" }, options, new AbortController().signal),
  ).toMatchObject({ status: "failed" });
});

test("moves refuse home or above before inspecting sources, and denied batches leave files untouched", async () => {
  expect(
    await runLocalTool(
      { name: "local_move", args: { moves: [{ from: "not-there", to: "other" }] }, callId: "call" },
      {
        ctx,
        workspace: "/",
        conversationId: "chat",
        freeReadRoots: [],
        skills: [],
        mode: "ask",
        sessionFolder: session,
        printBash: () => {},
        ask: async () => {
          throw new Error("Must not ask");
        },
      },
      new AbortController().signal,
    ),
  ).toEqual({
    status: "denied",
    moved: [],
    conflicts: [],
    error: "cld was started in your home folder or above; start it in the folder you want to organize.",
  });
  await writeFile(join(workspace, "a"), "original");
  approve = false;
  expect(await run("local_move", { moves: [{ from: "a", to: "b" }] })).toEqual({
    status: "denied",
    moved: [],
    conflicts: [],
    error: "The user declined.",
  });
  expect(await readFile(join(workspace, "a"), "utf8")).toBe("original");
  expect(await Bun.file(join(workspace, "b")).exists()).toBeFalse();
});

test("an upload through an outside directory alias goes to the chat root", async () => {
  await mkdir(join(root, "outside"));
  await writeFile(join(root, "outside/invoice.txt"), "invoice");
  await symlink(join(root, "outside"), join(workspace, "alias"));
  expect(await run("local_upload", { paths: ["alias/invoice.txt"] })).toMatchObject({
    status: "completed",
    files: [{ chatPath: "/returned/invoice.txt" }],
  });
  expect(uploads).toEqual([{ name: "invoice.txt", directory: "/" }]);
  expect(questions).toHaveLength(1);
});
