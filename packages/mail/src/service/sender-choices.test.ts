import { beforeEach, expect, mock, test } from "bun:test";
import { UserSchema } from "@k2b/cloud/contracts";
import { sql } from "bun";
import type { MailRequestContext } from "./auth";

// The isolated child keeps service mocks out of every other Mail test file.
if (process.env.MAIL_SENDER_CHOICES_CHILD !== "1") {
  test("sender consequence reads respect mailbox access and personal defaults", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, MAIL_SENDER_CHOICES_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: code === 0 ? "passed" : `${stdout}\n${stderr}` }).toEqual({ code: 0, output: "passed" });
  }, 60_000);
} else {
  const user = UserSchema.parse({
    id: "10000000-0000-4000-8000-000000000001",
    uid: "alice",
    provider: "local",
    profile: "user",
    roles: ["user"],
    givenname: "Alice",
    sn: "Example",
    displayName: "Alice",
    mail: null,
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  });
  const context: MailRequestContext = { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id } };
  let allowed = true;
  let personalTemplateId = "personal";
  const audience = { memberCount: 8, guestCount: 1, serviceAccountCount: 1, public: false, authenticated: false };
  const reads: string[] = [];
  const db = (async (parts: TemplateStringsArray) => {
    reads.push(parts.join("?"));
    return parts.join("").includes("mailbox_assigned_access") ? [{ exists: true }] : [{ access_id: "grant" }];
  }) as unknown as typeof sql;
  mock.module("@k2b/cloud/server", () => ({ summarizeAccessAudience: async () => audience }));
  mock.module("./access", () => ({
    requireMailboxAccess: async () =>
      allowed ? { ok: true, data: {} } : { ok: false, error: { code: "FORBIDDEN", message: "Denied", status: 403 } },
  }));
  mock.module("./sender-identities", () => ({
    listSenderIdentities: async () => {
      reads.push("identities");
      return {
        ok: true,
        data: [
          {
            id: "sender",
            label: "Support",
            fromAddress: "support@example.test",
            status: "verified",
            replyTo: "replies@example.test",
            defaultCc: [{ address: "copy@example.test" }],
            defaultBcc: [{ address: "archive@example.test" }],
            defaultSignatureTemplateId: "shared",
          },
          {
            id: "unverified",
            label: "Pending",
            fromAddress: "pending@example.test",
            status: "unverified",
            replyTo: null,
            defaultCc: [],
            defaultBcc: [],
            defaultSignatureTemplateId: null,
          },
        ],
      };
    },
  }));
  mock.module("./compose-templates", () => ({
    listComposeTemplates: async () => ({
      ok: true,
      data: [
        { id: "personal", kind: "signature", name: "My signature", bodyTemplate: "Do not expose template bodies" },
        { id: "shared", kind: "signature", name: "Team signature" },
      ],
    }),
    listComposeSignatureDefaults: async () => ({
      ok: true,
      data: [{ senderIdentityId: "sender", userId: user.id, templateId: personalTemplateId }],
    }),
  }));
  const { listSenderChoices } = await import("./sender-choices");
  beforeEach(() => {
    reads.length = 0;
    allowed = true;
    personalTemplateId = "personal";
  });

  test("denied compose access stops before identity, template or audience reads", async () => {
    allowed = false;
    expect(await listSenderChoices(context, "mailbox", db)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(reads).toEqual([]);
  });
  test("projects sender-specific consequences and retains unverified identities", async () => {
    const result = await listSenderChoices(context, "mailbox", db);
    expect(result).toMatchObject({
      ok: true,
      data: [
        {
          id: "sender",
          signatureName: "My signature",
          audience,
          assignedReaders: true,
          replyTo: "replies@example.test",
          defaultCc: [{ address: "copy@example.test" }],
          defaultBcc: [{ address: "archive@example.test" }],
        },
        { id: "unverified", status: "unverified", replyTo: "pending@example.test", signatureName: null },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("bodyTemplate");
    expect(reads.filter((read) => /INSERT|UPDATE|DELETE/.test(read))).toEqual([]);
  });
  test("an unavailable personal signature falls back to the same shared default as compose", async () => {
    personalTemplateId = "archived";
    expect(await listSenderChoices(context, "mailbox", db)).toMatchObject({ ok: true, data: [{ signatureName: "Team signature" }, {}] });
  });
}
