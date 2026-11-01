import { describe, expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { mailCapabilities } from "../capabilities";
import { MAIL_CODE_OPERATION_LEVELS, mailboxCodeAccessDecision } from "./code-access";

describe("Mail Code access contract", () => {
  test("declares mailboxes as targets and owners and generates the Core access operations", () => {
    const manifest = compileCapabilityManifest("mail", mailCapabilities);
    expect(manifest.code).toEqual({
      access: { app: false, types: ["mailbox"] },
      owners: ["mailbox"],
      pages: { mailbox: "/app/mail/{id}/code" },
    });
    expect(
      manifest.actions
        .filter((action) => action.localId.startsWith("code.access."))
        .map((action) => action.localId)
        .sort(),
    ).toEqual(["code.access.rm", "code.access.set"]);
    expect(manifest.queries.some((query) => query.localId === "code.access.list")).toBe(true);
  });

  test("requires a deliberate Mail level for every declared Query and Action", () => {
    expect(Object.keys(MAIL_CODE_OPERATION_LEVELS).sort()).toEqual(
      [...Object.keys(mailCapabilities.queries), ...Object.keys(mailCapabilities.actions)].sort(),
    );
  });

  test("chooses the smallest sufficient level, including write-only send safety review", () => {
    expect(mailboxCodeAccessDecision(["mail.mailbox.read", "mail.draft.read", "mail.search"], false)).toEqual({
      granted: true,
      level: "read",
    });
    expect(mailboxCodeAccessDecision(["mail.mailbox.read", "mail.draft.create"], false)).toEqual({ granted: true, level: "write" });
    expect(mailboxCodeAccessDecision(["mail.draft.send.review"], false)).toEqual({ granted: true, level: "write" });
  });

  test("refuses the whole request if any operation lacks a non-manager level", () => {
    for (const operation of [
      "mail.folder.display.set",
      "mail.conversation.keep.release",
      "mail.code.access.set",
      "mail.future.action",
      "spaces.task.create",
      "mail.toString",
      "mail.constructor",
      "mail.__proto__",
    ]) {
      const decision = mailboxCodeAccessDecision(["mail.draft.create", operation], false);
      expect(decision.granted).toBe(false);
      if (!decision.granted) expect(decision.reason).toContain(operation);
    }
  });

  test("allows empty operations only for an owner dry run", () => {
    expect(mailboxCodeAccessDecision([], true)).toEqual({ granted: true, level: "read" });
    expect(mailboxCodeAccessDecision([], false).granted).toBe(false);
  });
});
