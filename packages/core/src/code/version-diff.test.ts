import { describe, expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { CAPABILITY_MAX_RESULT_BYTES, CapabilityActionCallReviewSchema } from "@k2b/cloud/contracts";
import type { CodeDiffFile } from "@k2b/ui";
import { aiCapabilities } from "../capabilities";
import { codeBundleHash, codeSourceHash } from "./store";
import { CodeCheckedVersionManifestSchema, codeVersionContracts } from "./version-contracts";
import { codeVersionDiff } from "./version-diff";
import { codeVersionMessages } from "./version-messages";

const join = (rows: CodeDiffFile["lines"], side: "old" | "new") =>
  rows
    .filter((line) => line.kind !== (side === "old" ? "add" : "del"))
    .map((line) => line.text)
    .join("\n");
describe("C8 complete CodeDiff and submission contracts", () => {
  test("every file reconstructs both complete versions, with full unchanged context", () => {
    const before = { "a.ts": "first\nold\nlast\n", "same.ts": "unchanged\n", "gone.ts": "gone" };
    const after = { "a.ts": "first\nnew\nlast\n", "same.ts": "unchanged\n", "new.ts": "new" };
    const files: CodeDiffFile[] = codeVersionDiff(before, after);
    expect(files.map((file) => file.path)).toEqual(["a.ts", "gone.ts", "new.ts", "same.ts"]);
    for (const file of files) {
      expect(join(file.lines, "old")).toBe(Object.hasOwn(before, file.path) ? Reflect.get(before, file.path) : "");
      expect(join(file.lines, "new")).toBe(Object.hasOwn(after, file.path) ? Reflect.get(after, file.path) : "");
    }
    expect(files[0]?.lines).toEqual([
      { kind: "same", text: "first" },
      { kind: "del", text: "old" },
      { kind: "add", text: "new" },
      { kind: "same", text: "last" },
      { kind: "same", text: "" },
    ]);
    expect(files[3]?.lines.every((line) => line.kind === "same")).toBe(true);
  });
  test("newline-only edits, CRLF, empty and Unicode files retain all rows", () => {
    for (const [before, after] of [
      ["a", "a\n"],
      ["a\r\nb\r\n", "a\nb\n"],
      ["", "\n"],
      ["\n", ""],
      ["😀\nlet a=1", "😀\nlet a=2"],
    ]) {
      const [file] = codeVersionDiff({ "a.ts": before! }, { "a.ts": after! });
      expect(join(file!.lines, "old")).toBe(before!);
      expect(join(file!.lines, "new")).toBe(after!);
      expect(file!.lines.some((line) => line.kind !== "same")).toBe(true);
      expect(file!.lines.every((line) => !line.text.includes("\n"))).toBe(true);
    }
  });
  test("large replacements keep the whole row list even if the diff budget expires", () => {
    const before = Array.from({ length: 4000 }, (_, n) => `old ${n}`).join("\n");
    const after = Array.from({ length: 4000 }, (_, n) => `new ${n}`).join("\n");
    const [file] = codeVersionDiff({ "a.ts": before }, { "a.ts": after });
    expect(join(file!.lines, "old")).toBe(before);
    expect(join(file!.lines, "new")).toBe(after);
    expect(file!.lines).toHaveLength(8000);
  });
  test("replacement mode is deterministic and preserves all rows for chunked reads", () => {
    const before = { "a.ts": "first\nold\nlast\n" },
      after = { "a.ts": "first\nnew\nlast\n" };
    const files = codeVersionDiff(before, after, "replacement");
    expect(files).toEqual(codeVersionDiff(before, after, "replacement"));
    expect(join(files[0]!.lines, "old")).toBe(before["a.ts"]);
    expect(join(files[0]!.lines, "new")).toBe(after["a.ts"]);
  });
  test("complete comparison chunks fit the capability transport for Unicode and escaped JSON", () => {
    const input = codeVersionContracts.diffRead.input.parse({
      codeId: "c_test",
      versionId: "11111111-1111-4111-8111-111111111111",
      comparisonVersionId: null,
    });
    expect(input.length).toBe(65_536);
    for (const character of ["\uE000", "\\", '"']) {
      const text = character.repeat(input.length);
      expect(Buffer.byteLength(JSON.stringify({ ok: true, data: { content: { text, nextOffset: input.length } } }))).toBeLessThan(
        CAPABILITY_MAX_RESULT_BYTES,
      );
    }
    expect(codeVersionContracts.diffRead.input.safeParse({ ...input, length: 65_537 }).success).toBe(false);
  });
  test("checked manifest requires exact hashes, classifications, targets and source evidence", () => {
    const sourceFiles = { "a.ts": "hello" },
      bundle = "bundle";
    const manifest = {
      version: 1,
      entry: "a.ts",
      hashes: { source: codeSourceHash(sourceFiles, "a.ts"), bundle: codeBundleHash(bundle), sdk: "a".repeat(64) },
      entrypoints: [{ kind: "manual", entrypoint: "run", cron: null, file: "a.ts", line: 1 }],
      ai: false,
      policyRows: ["read"],
      permissions: [
        {
          operation: "example.item.read",
          target: { type: "example.item", id: "item" },
          file: "a.ts",
          line: 1,
        },
      ],
    };
    expect(CodeCheckedVersionManifestSchema.safeParse(manifest).success).toBe(true);
    expect(codeSourceHash(sourceFiles, "a.ts")).not.toBe(codeSourceHash(sourceFiles, "b.ts"));
    expect(codeSourceHash(sourceFiles, "a.ts")).toBe(
      new Bun.CryptoHasher("sha256").update(JSON.stringify({ entry: "a.ts", files: [["a.ts", "hello"]] })).digest("hex"),
    );
    expect(CodeCheckedVersionManifestSchema.safeParse({ ...manifest, ai: true }).success).toBe(false);
    expect(CodeCheckedVersionManifestSchema.safeParse({ ...manifest, policyRows: ["read", "read"] }).success).toBe(false);
    expect(
      CodeCheckedVersionManifestSchema.safeParse({ ...manifest, permissions: [{ ...manifest.permissions[0], line: 0 }] }).success,
    ).toBe(false);
    expect(
      codeVersionContracts.submit.input.safeParse({ codeId: "c_test", sourceFiles, bundle, manifest, baseVersionId: null }).success,
    ).toBe(true);
    expect(codeVersionContracts.submit.input.safeParse({ codeId: "c_test", sourceFiles, bundle, manifest }).success).toBe(false);
  });
  test("submission and decisions are excluded from resource-owned Code; policy reasons stay explicit", () => {
    const manifest = compileCapabilityManifest("core", aiCapabilities);
    const actions = manifest.actions.filter((action) =>
      [
        "code.run",
        "code.secret.set",
        "code.secret.delete",
        "code.version.submit",
        "code.version.approve",
        "code.version.reject",
        "code.pause",
        "code.resume",
      ].includes(action.localId),
    );
    expect(actions).toHaveLength(8);
    expect(actions.every((action) => action.code === false)).toBe(true);
    expect(actions.every((action) => action.target === "code")).toBe(true);
    for (const action of actions) expect(action.inputSchema).not.toHaveProperty("properties.codeId");
    expect(aiCapabilities.actions["code.version.approve"].policy).toEqual({ ask: "changes_access" });
    expect(aiCapabilities.actions["code.version.reject"].policy).toEqual({ ask: "changes_access" });
    expect(codeVersionMessages.check()).toEqual([]);
    expect(
      CapabilityActionCallReviewSchema.safeParse({
        locale: "en",
        sentence: {
          action: "Approve this Code version",
          running: "Approving this Code version",
          done: "Approved this Code version",
          confirm: "Approve version",
          decline: "Reject version",
        },
        slots: {},
        ask: "changes_access",
        content: { kind: "page", title: "Full diff", body: "{}", format: "plain" },
      }).success,
    ).toBe(true);
  });
});
