import { constants, createReadStream, type Stats } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, open, opendir, readdir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import {
  AI_PROJECT_FILE_MOUNT,
  AI_SKILL_FILE_MOUNT,
  CloudAiLoadLocalSkillInputSchema,
  CloudAiLocalDownloadInputSchema,
  CloudAiLocalListInputSchema,
  CloudAiLocalMoveInputSchema,
  CloudAiLocalReadInputSchema,
  CloudAiLocalUploadInputSchema,
  CloudAiLocalWriteInputSchema,
} from "@k2b/cloud/ai/browser";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { deniedLocalBashResult, parseLocalBashInput, runLocalBash } from "./local-bash";
import { type LocalSkill, readLocalSkill } from "./local-context";
import { classifyLocalPath, type LocalPathAccess, resolveLocalPath } from "./local-paths";
import { AI_API } from "./shared";
import { conversationPath, uploadAttachment } from "./turn";

const declined = { status: "denied", error: "The user declined." } as const;
const blocked = { status: "denied", error: "cld's configuration is never available to the assistant." } as const;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 2000);
const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep));
};
const realTarget = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT" || dirname(path) === path) throw error;
    return join(await realTarget(dirname(path)), basename(path));
  }
};
const existing = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
};
/** A size as people read it in a question: 512 B, 12 KB, 3.4 MB. */
const size = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const changed = (info: Stats): string => {
  const time = info.mtime.toTimeString().slice(0, 5);
  const day = info.mtime.toDateString() === new Date().toDateString() ? "today" : info.mtime.toISOString().slice(0, 10);
  return `${size(info.size)}, changed ${day} ${time}`;
};

export const createLocalSessionFolder = () => {
  let folder: Promise<string> | undefined;
  return {
    get: () =>
      (folder ??= (async () => {
        const path = await realpath(await mkdtemp(join(tmpdir(), "cld-")));
        await chmod(path, 0o700);
        return path;
      })()),
    roots: async () => (folder ? [await folder] : []),
    close: async () => {
      if (folder) await rm(await folder, { recursive: true, force: true });
    },
  };
};

type LocalToolsOptions = {
  ctx: CloudCliContext;
  workspace: string;
  conversationId: string;
  freeReadRoots: readonly string[];
  skills: readonly LocalSkill[];
  mode: "ask" | "off";
  ask: (lines: string[], question: string) => Promise<boolean>;
  sessionFolder: ReturnType<typeof createLocalSessionFolder>;
  printBash: (stdout: string, stderr: string, truncated: boolean) => void;
};

/** Local calls use the same path policy as explicit attachments, with trusted reference folders added for reads. */
export const runLocalTool = async (
  call: { name: string; args: unknown; callId: string },
  options: LocalToolsOptions,
  externalSignal: AbortSignal,
  deadlineMs = 120_000,
): Promise<unknown> => {
  if (options.mode === "off")
    return call.name === "local_bash"
      ? deniedLocalBashResult("Local tools are off in this session.")
      : call.name === "local_move"
        ? { status: "denied", moved: [], conflicts: [], error: "Local tools are off in this session." }
        : { status: "denied", error: "Local tools are off in this session." };
  const workspace = await realpath(options.workspace);
  const deadline = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restartDeadline = () => {
    if (call.name !== "local_bash")
      timer = setTimeout(() => deadline.abort(new DOMException("The operation timed out.", "TimeoutError")), deadlineMs);
  };
  restartDeadline();
  const signal = call.name === "local_bash" ? externalSignal : AbortSignal.any([externalSignal, deadline.signal]);
  const ask = async (lines: string[], question: string) => {
    signal.throwIfAborted();
    clearTimeout(timer);
    try {
      return await options.ask(lines, question);
    } finally {
      restartDeadline();
    }
  };
  const becomesInstructions = async (path: string) =>
    [path, resolveLocalPath(path, workspace), await realTarget(resolveLocalPath(path, workspace))].some(
      (target) =>
        basename(target).toLowerCase() === "agents.md" || target.split(sep).some((segment) => segment.toLowerCase() === ".agents"),
    );
  const display = (path: string) => (inside(workspace, path) ? relative(workspace, path) || "." : path);
  const access = async (path: string, readOnly = false): Promise<LocalPathAccess> => {
    const rule = classifyLocalPath(path, { workspace });
    // Skill and session folders free reads elsewhere, never of files that may hold secrets.
    if (rule.access === "blocked" || (rule.access === "ask" && rule.reason === "protected") || !readOnly) return rule;
    const target = await realTarget(path);
    const roots = [...options.freeReadRoots, ...(await options.sessionFolder.roots())];
    return roots.some((root) => inside(root, target)) ? { access: "free" } : rule;
  };
  const reason = (rule: Extract<LocalPathAccess, { access: "ask" }>) =>
    rule.reason === "home" ? "home folder" : rule.reason === "protected" ? "may contain secrets" : `outside ${workspace}`;
  const authorize = async (path: string, verb: string, readOnly = false, review?: string) => {
    signal.throwIfAborted();
    const given = resolveLocalPath(path, workspace);
    const rule = await access(given, readOnly);
    if (rule.access === "blocked") return blocked;
    const instructions = !readOnly && (await becomesInstructions(path));
    if (rule.access === "free" && !review && !instructions) return null;
    const question =
      review ??
      `${verb} ${display(given)}? ${
        instructions
          ? "It becomes instructions for the assistant."
          : rule.access === "ask" && rule.reason === "home"
            ? "You started cld in your home folder or above, so every file asks first."
            : rule.access === "ask" && rule.reason === "protected"
              ? "It may contain secrets."
              : `It is outside ${workspace}.`
      }`;
    const lines = review && rule.access === "ask" ? [`${display(given)}: ${reason(rule)}`] : [];
    if (review && instructions) lines.push(`${display(given)}: becomes instructions for the assistant`);
    const allowed = await ask(lines, question);
    signal.throwIfAborted();
    return allowed ? null : declined;
  };
  const parents = async (path: string) => {
    if (inside(workspace, await realTarget(dirname(path)))) await mkdir(dirname(path), { recursive: true });
  };
  const upload = async (path: string, directory?: string) => {
    signal.throwIfAborted();
    const target = await realTarget(path);
    const parent = inside(workspace, target) ? relative(workspace, dirname(target)).split(sep).join("/") : "";
    const firstSegment = `/${parent.split("/")[0]}`;
    const derivedDirectory = [AI_PROJECT_FILE_MOUNT, AI_SKILL_FILE_MOUNT].includes(firstSegment) ? `/local/${parent}` : `/${parent}`;
    const result = await uploadAttachment(options.ctx, options.conversationId, path, directory ?? derivedDirectory, signal);
    if (result.type !== "attachment") throw new Error("Upload returned no chat file.");
    return { path: display(path), chatPath: result.path, mediaType: result.mediaType, size: result.size };
  };
  const save = async (path: string, old: Stats | null, write: (file: Awaited<ReturnType<typeof open>>) => Promise<void>) => {
    await parents(path);
    const temporary = old ? join(dirname(path), `.${basename(path)}.cld-${crypto.randomUUID()}.tmp`) : path;
    let created = false;
    try {
      const file = await open(temporary, "wx", old ? old.mode & 0o777 : 0o666);
      created = true;
      try {
        await write(file);
        signal.throwIfAborted();
      } finally {
        await file.close();
      }
      if (old) {
        await chmod(temporary, old.mode & 0o777);
        const current = await stat(path);
        if (current.ino !== old.ino || current.dev !== old.dev || current.size !== old.size || current.mtimeMs !== old.mtimeMs)
          throw new Error(`${display(path)} changed after review. Try again.`);
        await rename(temporary, path);
      }
    } catch (error) {
      if (created) await rm(temporary, { force: true });
      throw error;
    }
  };

  try {
    signal.throwIfAborted();
    switch (call.name) {
      case "local_bash": {
        const input = parseLocalBashInput(call.args);
        if (!input) return { status: "failed", exitCode: null, stdout: "", stderr: "Invalid local Bash arguments.", truncated: false };
        if (!(await ask([`Bash wants to run in ${workspace}:`, "", `  ${input.command}`, ""], "Run?"))) return deniedLocalBashResult();
        signal.throwIfAborted();
        const result = await runLocalBash(input.command, { cwd: workspace, signal });
        signal.throwIfAborted();
        options.printBash(result.stdout, result.stderr, result.truncated);
        if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 64 * 1024) return result;
        const outputPath = join(
          await options.sessionFolder.get(),
          `${call.callId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${crypto.randomUUID()}.txt`,
        );
        const file = await open(outputPath, "wx", 0o600);
        try {
          await file.writeFile(`stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        } finally {
          await file.close();
        }
        const shorten = (text: string) => {
          const bytes = Buffer.from(text);
          if (bytes.length <= 32 * 1024) return text;
          return `${bytes.subarray(0, 16 * 1024).toString()}\n[… ${bytes.length - 32 * 1024} bytes omitted; full output: ${outputPath}]\n${bytes.subarray(-16 * 1024).toString()}`;
        };
        return { ...result, stdout: shorten(result.stdout), stderr: shorten(result.stderr), outputPath };
      }
      case "local_list": {
        const input = CloudAiLocalListInputSchema.parse(call.args);
        const path = resolveLocalPath(input.path, workspace);
        const denial = await authorize(path, "List", true);
        if (denial) return denial;
        const pattern = input.pattern ? new Bun.Glob(input.pattern.toLowerCase()) : null;
        const recursive = input.recursive || !!input.pattern?.includes("/") || !!input.pattern?.includes("**");
        const entries: Array<{ path: string; type: "file" | "directory" | "other"; size: number; modifiedAt: string }> = [];
        let visited = 0;
        const walk = async (folder: string): Promise<void> => {
          for await (const entry of await opendir(folder)) {
            signal.throwIfAborted();
            if (++visited > 100_000) throw new Error("Too many entries; list a smaller folder or use a narrower pattern.");
            const target = join(folder, entry.name);
            const relativePath = relative(path, target).split(sep).join("/");
            if (!pattern || pattern.match(relativePath.toLowerCase())) {
              const info = await lstat(target);
              entries.push({
                path: display(target),
                type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
                size: info.size,
                modifiedAt: info.mtime.toISOString(),
              });
            }
            if (
              recursive &&
              entry.isDirectory() &&
              ![".git", ".ssh", ".gnupg", ".aws"].includes(entry.name) &&
              (await access(target, true)).access !== "blocked"
            )
              await walk(target);
          }
        };
        await walk(path);
        entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        const remaining = entries.filter((entry) => !input.after || entry.path > input.after);
        const page = remaining.slice(0, input.limit);
        return {
          status: "completed",
          path: display(path),
          entries: page,
          nextAfter: remaining.length > page.length ? page.at(-1)!.path : null,
        };
      }
      case "local_read": {
        const input = CloudAiLocalReadInputSchema.parse(call.args);
        const path = resolveLocalPath(input.path, workspace);
        const denial = await authorize(path, "Read", true);
        if (denial) return denial;
        const info = await stat(path);
        if (!info.isFile()) throw new Error(`${display(path)} is a folder; list it and read its files.`);
        if (
          ["pdf", "png", "jpg", "jpeg", "webp", "gif", "heic", "docx", "doc", "odt", "rtf", "xlsx", "xls", "ods", "pptx", "odp"].includes(
            extname(path).slice(1).toLowerCase(),
          )
        )
          return { status: "completed", kind: "uploaded", ...(await upload(path)) };
        if (new Uint8Array(await Bun.file(path).slice(0, 8192).arrayBuffer()).includes(0))
          throw new Error("Binary file. Upload it with local_upload if a Cloud tool can read it.");
        let line = 0;
        let used = 0;
        let content = "";
        let lastLine = 0;
        let nextOffset: number | null = null;
        for await (const item of readFileLines(path, input.maxBytes, signal)) {
          line++;
          if (line < input.offset) continue;
          const cost = item.length + (item.newline ? 1 : 0);
          if (used && used + cost > input.maxBytes) {
            nextOffset = line;
            break;
          }
          const shortened = item.length > input.maxBytes;
          content += `${line}\t${item.text}${shortened ? " [line shortened]" : ""}\n`;
          used += Math.min(cost, input.maxBytes);
          lastLine = line;
          if (shortened) {
            nextOffset = line + 1;
            break;
          }
        }
        return {
          status: "completed",
          kind: "text",
          path: display(path),
          content,
          firstLine: input.offset,
          lastLine,
          totalBytes: info.size,
          nextOffset,
        };
      }
      case "local_upload": {
        const input = CloudAiLocalUploadInputSchema.parse(call.args);
        const files: Array<{ path: string; chatPath: string; mediaType: string; size: number }> = [];
        const failed: Array<{ path: string; error: string }> = [];
        const candidates: Array<{ path: string; rule: Exclude<LocalPathAccess, { access: "blocked" }> }> = [];
        for (const given of input.paths) {
          const path = resolveLocalPath(given, workspace);
          try {
            const rule = await access(path);
            if (rule.access === "blocked") {
              failed.push({ path: display(path), error: blocked.error });
              continue;
            }
            if ((await stat(path)).isDirectory()) {
              failed.push({ path: display(path), error: `${display(path)} is a folder; list it and upload its files.` });
              continue;
            }
            candidates.push({ path, rule });
          } catch (error) {
            failed.push({ path: display(path), error: message(error) });
          }
        }
        const asking = candidates.filter((item) => item.rule.access === "ask");
        const approved =
          !asking.length ||
          (await ask(
            asking.map(({ path, rule }) => `  ${display(path)} (${rule.access === "ask" ? reason(rule) : ""})`),
            "Upload these files?",
          ));
        for (const [index, { path, rule }] of candidates.entries()) {
          try {
            signal.throwIfAborted();
            if (rule.access === "ask" && !approved) {
              failed.push({ path: display(path), error: declined.error });
              continue;
            }
            files.push(await upload(path, input.directory));
          } catch (error) {
            if (signal.aborted) {
              failed.push(...candidates.slice(index).map(({ path }) => ({ path: display(path), error: message(signal.reason) })));
              break;
            }
            failed.push({ path: display(path), error: message(error) });
          }
        }
        return { status: "completed", files, failed };
      }
      case "local_download": {
        const input = CloudAiLocalDownloadInputSchema.parse(call.args);
        const path = await realTarget(resolveLocalPath(input.to, workspace));
        if ((await access(resolveLocalPath(input.to, workspace))).access === "blocked") return blocked;
        const old = await existing(path);
        if (old && !input.replace)
          throw new Error(`${display(path)} exists. Choose another name, or use replace: true after the user agrees.`);
        if (old && !old.isFile()) throw new Error(`${display(path)} is not a file.`);
        const response = await options.ctx.fetch(
          `${AI_API}${conversationPath(options.conversationId, `/files/content?path=${encodeURIComponent(input.path)}`)}`,
          { signal },
        );
        if (!response.ok || !response.body) {
          await options.ctx.readJson(response);
          throw new Error("Chat file has no content.");
        }
        try {
          const length = response.headers.get("content-length");
          const denial = await authorize(
            input.to,
            "Save",
            false,
            old ? `Replace ${display(path)} (${changed(old)}) with ${length ? size(Number(length)) : "the chat file"}?` : undefined,
          );
          if (denial) return denial;
          let written = 0;
          await save(path, old, async (file) => {
            const reader = response.body!.getReader();
            try {
              while (true) {
                signal.throwIfAborted();
                const { done, value } = await reader.read();
                if (done) break;
                await file.writeFile(value);
                written += value.byteLength;
              }
            } finally {
              await reader.cancel().catch(() => undefined);
              reader.releaseLock();
            }
          });
          return { status: "completed", path: display(path), size: written, replaced: !!old };
        } finally {
          await response.body.cancel().catch(() => undefined);
        }
      }
      case "local_write": {
        const input = CloudAiLocalWriteInputSchema.parse(call.args);
        const given = resolveLocalPath(input.path, workspace);
        if ((await access(given)).access === "blocked") return blocked;
        const path = await realTarget(given);
        const old = await existing(path);
        if (input.mode === "create" && old) throw new Error(`${display(path)} exists. Use append or replace.`);
        if (input.mode !== "create" && !old) throw new Error(`${display(path)} does not exist. Use create.`);
        if (old && !old.isFile()) throw new Error(`${display(path)} is not a file.`);
        const bytes = Buffer.byteLength(input.content);
        const review = old
          ? input.mode === "append"
            ? `Append ${size(bytes)} to ${display(path)} (${changed(old)})?`
            : `Replace ${display(path)} (${changed(old)}) with ${size(bytes)}?`
          : undefined;
        const denial = await authorize(
          input.path,
          input.mode === "append" ? "Append to" : input.mode === "replace" ? "Replace" : "Write",
          false,
          review,
        );
        if (denial) return denial;
        if (input.mode === "append") {
          const file = await open(path, "r+");
          try {
            const current = await file.stat();
            if (!old || current.ino !== old.ino || current.dev !== old.dev || current.size !== old.size || current.mtimeMs !== old.mtimeMs)
              throw new Error(`${display(path)} changed after review. Try again.`);
            const buffer = Buffer.from(input.content);
            let written = 0;
            while (written < buffer.length) {
              signal.throwIfAborted();
              const result = await file.write(buffer, written, buffer.length - written, old.size + written);
              written += result.bytesWritten;
            }
          } finally {
            await file.close();
          }
        } else await save(path, input.mode === "replace" ? old : null, (file) => file.writeFile(input.content));
        return { status: "completed", path: display(path), mode: input.mode, size: (await stat(path)).size };
      }
      case "local_move": {
        const input = CloudAiLocalMoveInputSchema.parse(call.args);
        const moved: Array<{ from: string; to: string }> = [];
        const conflicts: Array<{ to: string; reason: string }> = [];
        const homeRule = classifyLocalPath(workspace, { workspace });
        if (homeRule.access === "ask" && homeRule.reason === "home")
          return {
            status: "denied",
            moved,
            conflicts,
            error: "cld was started in your home folder or above; start it in the folder you want to organize.",
          };
        const moves = [];
        for (const move of input.moves) {
          const from = resolveLocalPath(move.from, workspace);
          const givenTo = resolveLocalPath(move.to, workspace);
          if ([from, givenTo].some((path) => classifyLocalPath(path, { workspace }).access === "blocked"))
            return { ...blocked, moved, conflicts };
          if (
            !inside(workspace, await realTarget(from)) ||
            !inside(workspace, await realTarget(dirname(givenTo))) ||
            !inside(workspace, givenTo)
          )
            return { status: "denied", moved, conflicts, error: `Moves stay inside ${workspace}.` };
          const source = await lstat(from);
          const to = join(await realTarget(dirname(givenTo)), basename(givenTo));
          const target = await existing(to);
          const sameInode = target?.ino === source.ino && target.dev === source.dev;
          const names = sameInode ? await readdir(dirname(from)) : [];
          const caseOnly =
            from !== to &&
            from.toLowerCase() === to.toLowerCase() &&
            sameInode &&
            !(names.includes(basename(from)) && names.includes(basename(to)));
          moves.push({ from, to, source, target, caseOnly, instructions: await becomesInstructions(move.to) });
        }
        const targets = new Set<string>();
        for (const move of moves) {
          if (move.target && !move.caseOnly) conflicts.push({ to: display(move.to), reason: "Target exists." });
          else if (targets.has(move.to)) conflicts.push({ to: display(move.to), reason: "Duplicate target." });
          else if (moves.some((other) => other !== move && other.from === move.to))
            conflicts.push({ to: display(move.to), reason: "Target is another move's source." });
          targets.add(move.to);
        }
        if (conflicts.length) return { status: "failed", moved, conflicts };
        const width = Math.max(...moves.map((move) => display(move.from).length));
        const folders = moves.some((move) => move.source.isDirectory());
        const unit = folders ? "items" : moves.length === 1 ? "file" : "files";
        const lines = [
          `Move in ${workspace} (${moves.length} ${unit}):`,
          ...moves.map(
            (move) =>
              `  ${display(move.from).padEnd(width)} → ${display(move.to)}${move.instructions ? " (becomes instructions for the assistant)" : ""}`,
          ),
        ];
        if (!(await ask(lines, "Move?"))) return { status: "denied", moved, conflicts, error: declined.error };
        for (const move of moves) {
          try {
            signal.throwIfAborted();
            const current = await lstat(move.from);
            if (current.ino !== move.source.ino || current.dev !== move.source.dev || current.mtimeMs !== move.source.mtimeMs)
              throw new Error(`${display(move.from)} changed after review. Try again.`);
            await parents(move.to);
            if (move.caseOnly) {
              const temporary = join(dirname(move.from), `.${basename(move.from)}.cld-${crypto.randomUUID()}.tmp`);
              await rename(move.from, temporary);
              try {
                await rename(temporary, move.to);
              } catch (error) {
                await rename(temporary, move.from);
                throw error;
              }
            } else if (move.source.isFile()) {
              try {
                await link(move.from, move.to);
              } catch (error) {
                if (!(error instanceof Error) || !("code" in error) || error.code !== "EXDEV") throw error;
                await copyFile(move.from, move.to, constants.COPYFILE_EXCL);
              }
              try {
                await unlink(move.from);
              } catch (error) {
                await unlink(move.to);
                throw error;
              }
            } else {
              if (await existing(move.to)) throw Object.assign(new Error("Target exists."), { code: "EEXIST" });
              await rename(move.from, move.to);
            }
            moved.push({ from: display(move.from), to: display(move.to) });
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "EEXIST")
              conflicts.push({ to: display(move.to), reason: "Target appeared after review." });
            return { status: "failed", moved, conflicts, error: message(error) };
          }
        }
        return { status: "completed", moved, conflicts };
      }
      case "load_local_skill": {
        const input = CloudAiLoadLocalSkillInputSchema.parse(call.args);
        const skill = options.skills.find((item) => item.name === input.name);
        if (!skill) throw new Error("Skill not found or folder not trusted.");
        if (skill.manualOnly) throw new Error(`This Skill starts only when the user selects it with /${skill.name}.`);
        const denial = await authorize(skill.path, "Read", true);
        if (denial) return denial;
        const selected = await readLocalSkill(skill, workspace);
        const files: string[] = [];
        const walk = async (directory: string) => {
          for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            signal.throwIfAborted();
            if (files.length >= 50) return;
            if (entry.name.startsWith(".") || entry.name === "SKILL.md") continue;
            const path = join(directory, entry.name);
            if (entry.isDirectory()) await walk(path);
            else files.push(relative(selected.directory, path));
          }
        };
        await walk(selected.directory);
        return { status: "completed", ...selected, files };
      }
      default:
        throw new Error(`Unknown local tool: ${call.name}`);
    }
  } catch (error) {
    if (call.name === "local_bash") return { status: "failed", exitCode: null, stdout: "", stderr: message(error), truncated: false };
    if (call.name === "local_move") return { status: "failed", moved: [], conflicts: [], error: message(error) };
    return { status: "failed", error: message(error) };
  } finally {
    clearTimeout(timer);
  }
};

/** Retain at most one page of a line, even when a file has no newlines. */
async function* readFileLines(path: string, maxBytes: number, signal: AbortSignal) {
  const stream = createReadStream(path, { signal });
  let kept = Buffer.alloc(0);
  let length = 0;
  let shortened = false;
  try {
    for await (const chunk of stream) {
      if (!(chunk instanceof Buffer)) throw new Error("Unexpected file stream encoding.");
      let start = 0;
      while (start < chunk.length) {
        signal.throwIfAborted();
        const end = chunk.indexOf(10, start);
        const piece = chunk.subarray(start, end < 0 ? chunk.length : end);
        length += piece.length;
        if (kept.length < maxBytes) kept = Buffer.concat([kept, piece.subarray(0, maxBytes - kept.length)]);
        if (!shortened && length > maxBytes) {
          shortened = true;
          yield { text: new TextDecoder().decode(kept, { stream: true }), length, newline: end >= 0 };
        }
        if (end < 0) break;
        if (!shortened) yield { text: new TextDecoder().decode(kept).replace(/\r$/, ""), length, newline: true };
        kept = Buffer.alloc(0);
        length = 0;
        shortened = false;
        start = end + 1;
      }
    }
    if (length && !shortened) yield { text: new TextDecoder().decode(kept), length, newline: false };
  } finally {
    stream.destroy();
  }
}
