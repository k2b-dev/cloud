import { describe, expect, test } from "bun:test";
import {
  CloudAiReadFileOutputSchema,
  createCloudAiListFilesTool,
  createCloudAiReadFileTool,
  createCloudAiWriteFileTool,
  evaluateAiDate,
  evaluateAiMath,
} from "./file-tools";
import { aiFileStore } from "./files-store";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const projectFiles = {
  list: async () => [
    {
      path: "guides/triage.md",
      mediaType: "text/markdown",
      size: 8,
      updatedAt: "2026-08-15T12:00:00.000Z",
    },
  ],
  read: async (path: string) =>
    path === "guides/triage.md"
      ? {
          path,
          mediaType: "text/markdown",
          size: 8,
          updatedAt: "2026-08-15T12:00:00.000Z",
          bytes: new TextEncoder().encode("# Triage"),
        }
      : null,
};

const toolContext = {
  actor: { kind: "user" as const, user: { id: "user-1" } },
  conversationId: "conversation-1",
  projectFiles,
  signal: new AbortController().signal,
};

describe("AI Project file mount", () => {
  test("lists and reads loaded skills below their reserved read-only namespace", async () => {
    const list = createCloudAiListFilesTool();
    const read = createCloudAiReadFileTool();
    const write = createCloudAiWriteFileTool();
    if (list.location !== "server" || read.location !== "server" || write.location !== "server") throw new Error("Expected server tools");
    const content = bytes("# Weekly status");
    const context = {
      ...toolContext,
      skillFiles: {
        list: async () => [
          {
            path: "weekly-status/SKILL.md",
            mediaType: "text/markdown",
            size: content.byteLength,
            updatedAt: "2026-08-20T12:00:00.000Z",
          },
        ],
        read: async (path: string) =>
          path === "weekly-status/SKILL.md"
            ? {
                path,
                mediaType: "text/markdown",
                size: content.byteLength,
                updatedAt: "2026-08-20T12:00:00.000Z",
                bytes: content,
              }
            : null,
      },
    } as never;

    expect(await list.run({ path: "/skills" }, context)).toEqual({
      files: [
        {
          path: "/skills/weekly-status/SKILL.md",
          mediaType: "text/markdown",
          size: content.byteLength,
          origin: "skill",
          updatedAt: "2026-08-20T12:00:00.000Z",
        },
      ],
      truncated: false,
    });
    expect(await read.run({ path: "/skills/weekly-status/SKILL.md", offset: 0, length: 16_384 }, context)).toMatchObject({
      content: "# Weekly status",
      eof: true,
    });
    await expect(
      write.run({ path: "/skills/weekly-status/output.md", content: "No", mode: "overwrite" }, context),
    ).rejects.toThrow("/skills namespace is read-only");
  });

  test("lists and reads Project files below the reserved read-only namespace", async () => {
    const list = createCloudAiListFilesTool();
    const read = createCloudAiReadFileTool();
    const write = createCloudAiWriteFileTool();
    if (list.location !== "server" || read.location !== "server" || write.location !== "server") throw new Error("Expected server tools");

    expect(await list.run({ path: "/project" }, toolContext as never)).toEqual({
      files: [
        {
          path: "/project/guides/triage.md",
          mediaType: "text/markdown",
          size: 8,
          origin: "project",
          updatedAt: "2026-08-15T12:00:00.000Z",
        },
      ],
      truncated: false,
    });
    expect(await read.run({ path: "/project/guides/triage.md", offset: 0, length: 16_384 }, toolContext as never)).toEqual({
      path: "/project/guides/triage.md",
      mediaType: "text/markdown",
      representation: "text",
      content: "# Triage",
      offset: 0,
      nextOffset: 8,
      eof: true,
      truncated: false,
    });
    await expect(write.run({ path: "/project/result.md", content: "No", mode: "overwrite" }, toolContext as never)).rejects.toThrow(
      "/project namespace is read-only",
    );
  });

  test("converts a Project document to paged Markdown and rechecks the Project reader", async () => {
    const content = bytes("{\\rtf1\\ansi\\b Cloud\\b0  document}");
    let allowed = true;
    const read = createCloudAiReadFileTool();
    if (read.location !== "server") throw new Error("Expected server tool");
    const context = {
      ...toolContext,
      projectFiles: {
        list: async () => [],
        read: async (path: string) =>
          allowed && path === "notes.rtf"
            ? {
                path,
                mediaType: "application/rtf",
                size: content.byteLength,
                updatedAt: "2026-08-18T12:00:00.000Z",
                bytes: content,
              }
            : null,
      },
    } as never;

    const first = await read.run({ path: "/project/notes.rtf", offset: 0, length: 8 }, context);
    expect(first).toMatchObject({
      path: "/project/notes.rtf",
      mediaType: "application/rtf",
      representation: "markdown",
      offset: 0,
      eof: false,
      truncated: false,
    });
    const second = await read.run({ path: "/project/notes.rtf", offset: first.nextOffset, length: 16_384 }, context);
    expect(`${first.content}${second.content}`).toContain("**Cloud**");
    expect(second.eof).toBe(true);

    const csv = bytes("name,value\nalpha,42\n");
    const csvResult = await read.run({ path: "/project/values.csv", offset: 0, length: 16_384 }, {
      ...toolContext,
      projectFiles: {
        list: async () => [],
        read: async () => ({
          path: "values.csv",
          mediaType: "text/csv",
          size: csv.byteLength,
          updatedAt: "2026-08-18T12:00:00.000Z",
          bytes: csv,
        }),
      },
    } as never);
    expect(csvResult).toMatchObject({ representation: "markdown", eof: true, truncated: false });
    expect(csvResult.content).toContain("| alpha | 42 |");

    allowed = false;
    await expect(read.run({ path: "/project/notes.rtf", offset: 0, length: 16_384 }, context)).rejects.toThrow("No such Project file");
  });

  test("keeps direct text pagination on valid UTF-8 byte boundaries", async () => {
    const content = bytes("A😀B");
    const read = createCloudAiReadFileTool();
    if (read.location !== "server") throw new Error("Expected server tool");
    const context = {
      ...toolContext,
      projectFiles: {
        list: async () => [],
        read: async () => ({
          path: "unicode.txt",
          mediaType: "text/plain",
          size: content.byteLength,
          updatedAt: "2026-08-18T12:00:00.000Z",
          bytes: content,
        }),
      },
    } as never;

    const first = await read.run({ path: "/project/unicode.txt", offset: 0, length: 4 }, context);
    const second = await read.run({ path: "/project/unicode.txt", offset: first.nextOffset, length: 4 }, context);
    const third = await read.run({ path: "/project/unicode.txt", offset: second.nextOffset, length: 4 }, context);
    expect([first.content, second.content, third.content]).toEqual(["A", "😀", "B"]);
    expect([first.eof, second.eof, third.eof]).toEqual([false, false, true]);
    expect(first).toMatchObject({ representation: "text", truncated: false });
    await expect(read.run({ path: "/project/unicode.txt", offset: 2, length: 4 }, context)).rejects.toThrow("not valid UTF-8");
  });

  test("uses the immutable attached Turn bytes when extracting a document", async () => {
    const originalSlice = aiFileStore.readTurnSliceWithStat;
    const originalTurnFile = aiFileStore.readTurnFile;
    const originalRead = aiFileStore.read;
    const attached = bytes("{\\rtf1\\ansi Original snapshot}");
    const live = bytes("{\\rtf1\\ansi Replaced live file}");
    const stat = {
      path: "/draft.rtf",
      size: attached.byteLength,
      mediaType: "application/rtf",
      origin: "user" as const,
      updatedAt: "2026-08-18T12:00:00.000Z",
      version: 1,
    };
    aiFileStore.readTurnSliceWithStat = async (input) => ({
      ...stat,
      bytes: attached.slice(input.offset, input.offset + input.length),
    });
    let fullReads = 0;
    aiFileStore.readTurnFile = async () => {
      fullReads += 1;
      return { ...stat, bytes: attached };
    };
    aiFileStore.read = async () => ({ ...stat, size: live.byteLength, version: 2, bytes: live });
    try {
      const read = createCloudAiReadFileTool();
      if (read.location !== "server") throw new Error("Expected server tool");
      const result = await read.run({ path: "/draft.rtf", offset: 0, length: 16_384 }, {
        ...toolContext,
        turnId: "turn-1",
        attachedFilePaths: new Set(["/draft.rtf"]),
      } as never);

      expect(result.content).toContain("Original snapshot");
      expect(result.content).not.toContain("Replaced live file");
      expect(CloudAiReadFileOutputSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
      await read.run({ path: "/draft.rtf", offset: result.nextOffset, length: 16_384 }, {
        ...toolContext,
        turnId: "turn-1",
        attachedFilePaths: new Set(["/draft.rtf"]),
      } as never);
      expect(fullReads).toBe(1);
    } finally {
      aiFileStore.readTurnSliceWithStat = originalSlice;
      aiFileStore.readTurnFile = originalTurnFile;
      aiFileStore.read = originalRead;
    }
  });

  test("never reuses extracted content across contexts with identical file metadata", async () => {
    const read = createCloudAiReadFileTool();
    if (read.location !== "server") throw new Error("Expected server tool");
    const file = (content: string) => ({
      path: "same.rtf",
      mediaType: "application/rtf",
      size: bytes(content).byteLength,
      updatedAt: "2026-08-18T12:00:00.000Z",
      bytes: bytes(content),
    });
    const first = file("{\\rtf1\\ansi Context alpha}");
    const second = file("{\\rtf1\\ansi Context bravo}");
    expect(first.size).toBe(second.size);

    const run = (entry: ReturnType<typeof file>, identity: { userId: string; conversationId: string; turnId: string }) =>
      read.run({ path: "/project/same.rtf", offset: 0, length: 16_384 }, {
        ...toolContext,
        actor: { kind: "user", user: { id: identity.userId } },
        conversationId: identity.conversationId,
        turnId: identity.turnId,
        projectFiles: { list: async () => [], read: async () => entry },
      } as never);

    expect((await run(first, { userId: "user-1", conversationId: "conversation-1", turnId: "turn-1" })).content).toContain("Context alpha");
    const secondResult = await run(second, { userId: "user-2", conversationId: "conversation-2", turnId: "turn-2" });
    expect(secondResult.content).toContain("Context bravo");
    expect(secondResult.content).not.toContain("Context alpha");
  });

  test("keeps images on view_image and reports unsupported or oversized documents clearly", async () => {
    const read = createCloudAiReadFileTool();
    if (read.location !== "server") throw new Error("Expected server tool");
    const file = (path: string, mediaType: string, size: number, content = new Uint8Array([1, 2, 3])) => ({
      path,
      mediaType,
      size,
      updatedAt: "2026-08-18T12:00:00.000Z",
      bytes: content,
    });
    const run = (entry: ReturnType<typeof file>) =>
      read.run({ path: `/project/${entry.path}`, offset: 0, length: 16_384 }, {
        ...toolContext,
        projectFiles: { list: async () => [], read: async () => entry },
      } as never);

    await expect(run(file("photo.png", "image/png", 3))).rejects.toThrow("Use view_image");
    await expect(run(file("archive.bin", "application/octet-stream", 3))).rejects.toThrow("format is not supported");
    await expect(run(file("large.pdf", "application/pdf", 20 * 1024 * 1024 + 1))).rejects.toThrow("extraction limit");
  });
});

describe("AI calculate tool", () => {
  test("evaluates arithmetic without executing code", () => {
    expect(evaluateAiMath("2 + 3 * 4")).toBe(14);
    expect(evaluateAiMath("-2 ^ 2")).toBe(-4);
    expect(evaluateAiMath("2 ^ -2")).toBe(0.25);
    expect(evaluateAiMath("round(19.99 * 1.19, 2)")).toBe(23.79);
    expect(evaluateAiMath("1234567890123 + 1")).toBe(1234567890124);
    expect(() => evaluateAiMath("sqrt(4, 9)")).toThrow("expects 1 argument");
    expect(() => evaluateAiMath("round(1.234, 1.5)")).toThrow("round digits");
    expect(() => evaluateAiMath("process.exit()")).toThrow('Unexpected character "."');
    expect(() => evaluateAiMath("1 / 0")).toThrow("not a finite number");
  });

  test("uses deterministic ISO date arithmetic and clamps month ends", () => {
    expect(evaluateAiDate("2026-01-31 + 1 month")).toBe("2026-02-28");
    expect(evaluateAiDate("2024-02-29 + 1 year")).toBe("2025-02-28");
    expect(evaluateAiDate("2026-03-01 - 2 weeks")).toBe("2026-02-15");
    expect(evaluateAiDate("today", "America/Los_Angeles", new Date("2026-03-01T01:00:00Z"))).toBe("2026-02-28");
    expect(evaluateAiDate("today", "Europe/Copenhagen", new Date("2026-03-01T01:00:00Z"))).toBe("2026-03-01");
    expect(() => evaluateAiDate("03/01/2026 + 1 day")).toThrow("ISO date");
  });
});
