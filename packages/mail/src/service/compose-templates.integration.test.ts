import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { cameraExif, imageBytes, imageText, jpegSegment, tinyJpeg } from "../../../../scripts/fixtures/image-metadata";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { logoPng } from "../../test/mailbox-logo-fixtures";
import {
  type ComposeFormattingWarning,
  type DraftEditableContent,
  type DraftEditableContentInput,
  MAX_COMPOSE_FORMATTING_WARNINGS,
  type MailDraft,
} from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess, updateMailboxAccess } from "./access";
import { actorRefFromRequest, type MailRequestContext } from "./auth";
import {
  archiveComposeTemplate,
  createComposeTemplate,
  getMailboxComposeLogo,
  getMailboxComposeStyle,
  listComposeTemplates,
  previewComposeDraft,
  removeMailboxComposeLogo,
  renderComposeDraft,
  renderComposeSnippet,
  renderComposeSuggestions,
  setComposeSignatureDefault,
  updateComposeTemplate,
  updateMailboxComposeLogo,
  updateMailboxComposeStyle,
} from "./compose-templates";
import { acquireDraftLease, releaseDraftLease } from "./draft-leases";
import {
  createDraft,
  getDraft,
  listDraftRecoveryCopies,
  materializeDraftSeed,
  prepareDraftSeed,
  restoreDraftRecoveryCopy,
  updateDraft,
} from "./drafts";
import { currentMailboxLogo, deleteUnusedMailboxLogoVersions, mailboxLogoSha256 } from "./mailbox-logos";
import { createMailbox } from "./mailboxes";
import { updateSenderIdentity } from "./sender-identities";

const markComposeTemplateSegment = (source: string): string => `\u2063${source}\u2064`;

const suite = suiteFor("database", "nats");

const userContext = (id: string, uid: string, displayName: string, mail: string): MailRequestContext =>
  ({
    actor: {
      kind: "user",
      user: {
        id,
        uid,
        provider: "local",
        profile: "user",
        displayName,
        givenName: displayName.split(" ")[0] ?? displayName,
        sn: displayName.split(" ").slice(1).join(" "),
        mail,
        roles: ["user"],
        memberofGroupIds: [],
        memberofGroups: [],
      },
    },
    accessSubject: { type: "user", userId: id },
    requestId: `compose-template-test-${id}`,
  }) as never;

const delegatedContext = (context: MailRequestContext, serviceAccountId: string): MailRequestContext => {
  if (context.actor.kind !== "user") throw new Error("Delegated test context requires a user");
  return {
    actor: {
      kind: "service_account",
      serviceAccount: {
        id: serviceAccountId,
        name: "Delegated compose test",
        kind: "user_delegated",
        status: "active",
        delegatedUserId: context.actor.user.id,
        appId: null,
        resourceType: null,
        resourceId: null,
        createdBy: null,
        createdAt: new Date().toISOString(),
      } as never,
      delegatedUser: context.actor.user,
      scopes: ["mail:write"],
    },
    accessSubject: { type: "user", userId: context.actor.user.id },
    requestId: `delegated-compose-template-test-${context.actor.user.id}`,
  };
};

suite("mail compose templates", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const accessIds: string[] = [];
  let mailboxId = "";
  let senderIdentityId = "";
  let senderIdentityDbId = "";
  let delegatedServiceAccountId = "";
  let owner: MailRequestContext;
  let collaborator: MailRequestContext;

  beforeAll(async () => {
    await migrate();
    const [ownerRow, collaboratorRow] = await sql<{ id: string; uid: string; display_name: string; mail: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES
        (${`compose-owner-${suffix}`}, 'local', 'user', 'Ada Owner', ${`owner-${suffix}@example.test`}),
        (${`compose-writer-${suffix}`}, 'local', 'user', 'Grace Writer', ${`writer-${suffix}@example.test`})
      RETURNING id, uid, display_name, mail
    `;
    if (!ownerRow || !collaboratorRow) throw new Error("Compose test users were not created");
    userIds.push(ownerRow.id, collaboratorRow.id);
    owner = userContext(ownerRow.id, ownerRow.uid, ownerRow.display_name, ownerRow.mail);
    collaborator = userContext(collaboratorRow.id, collaboratorRow.uid, collaboratorRow.display_name, collaboratorRow.mail);
    const [serviceAccount] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind, delegated_user_id)
      VALUES (${`compose-delegated-${suffix}`}, 'user_delegated', ${collaboratorRow.id}::uuid)
      RETURNING id
    `;
    if (!serviceAccount) throw new Error("Delegated compose service account was not created");
    delegatedServiceAccountId = serviceAccount.id;

    const mailbox = await createMailbox(owner, { name: `Compose ${suffix}`, description: "Compose template test" });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const granted = await grantMailboxAccess({
      context: owner,
      mailboxId,
      principal: { type: "user", userId: collaboratorRow.id },
      permission: "write",
    });
    if (!granted.ok) throw new Error(granted.error.message);
    accessIds.push(granted.data.id);

    const [identity] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.sender_identities (short_id,
        mailbox_id, label, display_name, from_address, automation_policy, is_default, status
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid, 'Compose Test', 'Compose Test', ${`compose-${suffix}@example.test`}, 'disabled', true, 'verified'
      )
      RETURNING id, short_id
    `;
    if (!identity) throw new Error("Compose test sender identity was not created");
    senderIdentityDbId = identity.id;
    senderIdentityId = identity.id;
  });

  afterAll(async () => {
    if (mailboxId) {
      const rows = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      accessIds.push(...rows.map((row) => row.access_id));
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
    if (accessIds.length) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${[...new Set(accessIds)]}::jsonb))`;
    }
    if (delegatedServiceAccountId) {
      await sql`DELETE FROM auth.service_accounts WHERE id = ${delegatedServiceAccountId}::uuid`;
    }
    if (userIds.length) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    }
  });

  test("stale logo detail edits never restore an administrator's replaced logo", async () => {
    try {
      const input = { content: logoPng().toString("base64") };
      const first = await updateMailboxComposeLogo({ context: owner, mailboxId, input });
      if (!first.ok || !first.data.logo) throw new Error("Missing first logo");
      const staleVersion = { expectedVersionId: first.data.logo.versionId };
      const replacement = await updateMailboxComposeLogo({
        context: owner,
        mailboxId,
        input: { content: logoPng(2).toString("base64"), altText: "New logo" },
      });
      expect(replacement.ok).toBe(true);
      const stale = await updateMailboxComposeLogo({
        context: owner,
        mailboxId,
        input: { ...input, ...staleVersion, altText: "Old logo with edited text", displayWidth: 300 },
      });
      expect(stale).toMatchObject({ ok: false, error: { status: 409 } });
      expect(await getMailboxComposeLogo(owner, mailboxId)).toEqual(replacement);
      expect(await removeMailboxComposeLogo({ context: owner, mailboxId, ...staleVersion })).toMatchObject({
        ok: false,
        error: { status: 409 },
      });
      expect(await updateMailboxComposeLogo({ context: owner, mailboxId, input: { ...input, expectedVersionId: null } })).toMatchObject({
        ok: false,
        error: { status: 409 },
      });
      if (!replacement.ok || !replacement.data.logo) throw new Error("Missing replacement logo");
      expect(
        await removeMailboxComposeLogo({ context: owner, mailboxId, expectedVersionId: replacement.data.logo.versionId }),
      ).toMatchObject({ ok: true });
      expect(await updateMailboxComposeLogo({ context: owner, mailboxId, input: { ...input, ...staleVersion } })).toMatchObject({
        ok: false,
        error: { status: 409 },
      });
    } finally {
      await removeMailboxComposeLogo({ context: owner, mailboxId });
    }
  });

  test("mailbox logo permissions, validation, previews and removal share the compose contract", async () => {
    let logoSignature: { id: string; revision: number } | null = null;
    try {
      const bytes = logoPng();
      const input = { content: bytes.toString("base64") };
      const uploaded = await updateMailboxComposeLogo({ context: owner, mailboxId, input });
      expect(uploaded).toMatchObject({
        ok: true,
        data: {
          logo: {
            contentType: "image/png",
            pixelWidth: 1,
            pixelHeight: 1,
            displayWidth: 200,
            altText: `Compose ${suffix}`,
            byteLength: bytes.length,
            dataUrl: `data:image/png;base64,${input.content}`,
          },
        },
      });
      expect(await getMailboxComposeLogo(owner, mailboxId)).toEqual(uploaded);
      expect(await getMailboxComposeLogo(collaborator, mailboxId)).toEqual(uploaded);
      for (const permission of ["write", "read"] as const) {
        const accessId = accessIds[0];
        if (!accessId) throw new Error("Missing collaborator grant");
        const changed = await updateMailboxAccess({ context: owner, mailboxId, accessId, permission });
        if (!changed.ok) throw new Error(changed.error.message);
        try {
          expect(await updateMailboxComposeLogo({ context: collaborator, mailboxId, input })).toMatchObject({
            ok: false,
            error: { status: 403 },
          });
          expect(await removeMailboxComposeLogo({ context: collaborator, mailboxId })).toMatchObject({ ok: false, error: { status: 403 } });
          if (permission === "read")
            expect(await getMailboxComposeLogo(collaborator, mailboxId)).toMatchObject({ ok: false, error: { status: 403 } });
        } finally {
          await updateMailboxAccess({ context: owner, mailboxId, accessId, permission: "write" });
        }
      }
      for (const invalid of [
        { content: "***=" },
        { content: "YWJ" },
        { content: "YR==" },
        { content: "" },
        { content: Buffer.alloc(102401).toString("base64") },
        { content: logoPng(1201).toString("base64") },
        { content: logoPng(1, 401).toString("base64") },
        { content: Buffer.from("GIF89a").toString("base64") },
        { ...input, displayWidth: 0 },
        { ...input, displayWidth: 601 },
        { ...input, altText: " " },
        { ...input, altText: "a".repeat(201) },
        { ...input, altText: "\nTeam" },
        { ...input, altText: "Team\u007f" },
      ])
        expect(await updateMailboxComposeLogo({ context: owner, mailboxId, input: invalid })).toMatchObject({
          ok: false,
          error: { status: 400 },
        });
      const signature = await createComposeTemplate({
        context: owner,
        mailboxId,
        input: { kind: "signature", scope: "mailbox", name: "Logo", shortcut: "logo", body: "Regards\n\n{{ mailbox.logo }}" },
      });
      if (!signature.ok) throw new Error(signature.error.message);
      logoSignature = signature.data;
      const draft: DraftEditableContentInput = {
        senderIdentityId,
        to: [],
        cc: [],
        bcc: [],
        subject: "Logo preview",
        body: "Hello",
        format: "markdown",
        signatureTemplateId: signature.data.id,
      };
      const preview = await previewComposeDraft({ context: owner, mailboxId, input: { draft, conversationId: null } });
      expect(preview.ok).toBe(true);
      if (!preview.ok) throw new Error(preview.error.message);
      expect(preview.data.html).toContain(`src="data:image/png;base64,${input.content}"`);
      expect(preview.data.text).toContain(`Compose ${suffix}`);
      expect(await removeMailboxComposeLogo({ context: owner, mailboxId })).toEqual({ ok: true, data: { logo: null } });
      expect(await removeMailboxComposeLogo({ context: owner, mailboxId })).toEqual({ ok: true, data: { logo: null } });
      expect(await getMailboxComposeLogo(owner, mailboxId)).toEqual({ ok: true, data: { logo: null } });
      const empty = await previewComposeDraft({ context: owner, mailboxId, input: { draft, conversationId: null } });
      expect(empty).toMatchObject({ ok: true, data: { formattingWarnings: [{ code: "missing_mailbox_logo" }] } });
      if (empty.ok) {
        expect(empty.data.html).not.toContain("<img");
        expect(empty.data.html).not.toContain("MAILLOGO");
        expect(empty.data.text).not.toContain("MAILLOGO");
      }
      expect(await sql`SELECT id FROM mail.mailbox_logo_versions WHERE mailbox_id = ${mailboxId}::uuid`).toHaveLength(0);
    } finally {
      try {
        if (logoSignature)
          expect(
            await archiveComposeTemplate({
              context: owner,
              mailboxId,
              templateId: logoSignature.id,
              input: { expectedRevision: logoSignature.revision },
            }),
          ).toMatchObject({ ok: true });
      } finally {
        expect(await removeMailboxComposeLogo({ context: owner, mailboxId })).toMatchObject({ ok: true });
      }
    }
  });

  test("logo uploads store and describe stripped JPEG bytes without private EXIF or GPS", async () => {
    const jpeg = await tinyJpeg();
    // Orientation 1 needs no retained EXIF segment; all camera metadata must go.
    const original = imageBytes(
      jpeg.subarray(0, 2),
      jpegSegment(0xe1, cameraExif(1)),
      jpegSegment(0xfe, imageText("GPS private location")),
      jpeg.subarray(2),
    );
    expect(Buffer.from(original).includes(Buffer.from("Exif"))).toBe(true);
    expect(Buffer.from(original).includes(Buffer.from("GPS"))).toBe(true);
    try {
      const uploaded = await updateMailboxComposeLogo({
        context: owner,
        mailboxId,
        input: { content: Buffer.from(original).toString("base64") },
      });
      expect(uploaded).toMatchObject({ ok: true });
      if (!uploaded.ok) throw new Error(uploaded.error.message);
      const stored = await currentMailboxLogo(sql, mailboxId, false);
      if (!stored) throw new Error("Uploaded JPEG is missing");
      expect(stored.content).toEqual(Buffer.from(jpeg));
      for (const marker of ["Exif", "GPS", "Apple"]) expect(stored.content.includes(Buffer.from(marker))).toBe(false);
      expect(stored.sha256).toBe(mailboxLogoSha256(jpeg));
      expect(stored.sha256).not.toBe(mailboxLogoSha256(original));
      expect(uploaded.data.logo).toMatchObject({
        byteLength: jpeg.byteLength,
        sha256: mailboxLogoSha256(jpeg),
        dataUrl: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`,
      });
    } finally {
      expect(await removeMailboxComposeLogo({ context: owner, mailboxId })).toMatchObject({ ok: true });
    }
  });

  test("cleanup skips a logo locked by an in-flight send render", async () => {
    try {
      const input = { content: logoPng().toString("base64") };
      const uploaded = await updateMailboxComposeLogo({ context: owner, mailboxId, input });
      if (!uploaded.ok) throw new Error(uploaded.error.message);
      let oldVersionId = "";
      await sql.begin(async (tx) => {
        const locked = await currentMailboxLogo(tx, mailboxId, true);
        if (!locked) throw new Error("Logo missing before lock");
        oldVersionId = locked.id;
        expect(await updateMailboxComposeLogo({ context: owner, mailboxId, input: { ...input, displayWidth: 300 } })).toMatchObject({
          ok: true,
        });
        expect(await deleteUnusedMailboxLogoVersions({ mailboxId, limit: 10 })).toBe(0);
        expect(await tx`SELECT id FROM mail.mailbox_logo_versions WHERE id = ${oldVersionId}::uuid`).toHaveLength(1);
      });
      expect(await deleteUnusedMailboxLogoVersions({ mailboxId, limit: 10 })).toBe(1);
      expect(await sql`SELECT id FROM mail.mailbox_logo_versions WHERE id = ${oldVersionId}::uuid`).toHaveLength(0);
      expect(await removeMailboxComposeLogo({ context: owner, mailboxId })).toMatchObject({ ok: true });
    } finally {
      expect(await removeMailboxComposeLogo({ context: owner, mailboxId })).toMatchObject({ ok: true });
    }
  });

  test("keeps private templates private and chooses the personal default before the mailbox default", async () => {
    const privateSignature = await createComposeTemplate({
      context: owner,
      mailboxId,
      input: {
        kind: "signature",
        scope: "private",
        name: "My signature",
        shortcut: "mine",
        body: "Regards,\n{{ actor.display_name }}",
      },
    });
    expect(privateSignature.ok).toBe(true);
    if (!privateSignature.ok) return;
    const duplicateShortcut = await createComposeTemplate({
      context: owner,
      mailboxId,
      input: {
        kind: "snippet",
        scope: "private",
        name: "Duplicate shortcut",
        shortcut: "mine",
        body: "Duplicate",
      },
    });
    expect(duplicateShortcut).toMatchObject({
      ok: false,
      error: { status: 400, message: "This shortcut is already used by another visible template" },
    });

    const mailboxSnippet = await createComposeTemplate({
      context: owner,
      mailboxId,
      input: {
        kind: "snippet",
        scope: "mailbox",
        name: "Welcome",
        shortcut: "welcome",
        body: "Hello from {{ mailbox.name }}, {{ actor.display_name }} ({{ actor.email }})",
      },
    });
    expect(mailboxSnippet.ok).toBe(true);
    if (!mailboxSnippet.ok) return;

    const visibleToCollaborator = await listComposeTemplates(collaborator, mailboxId);
    expect(visibleToCollaborator.ok).toBe(true);
    if (!visibleToCollaborator.ok) return;
    expect(visibleToCollaborator.data.map((template) => template.id)).toEqual([mailboxSnippet.data.id]);

    const mailboxSignature = await createComposeTemplate({
      context: owner,
      mailboxId,
      input: {
        kind: "signature",
        scope: "mailbox",
        name: "Team signature",
        shortcut: "team",
        body: "Team regards,\n{{ actor.display_name }}",
      },
    });
    expect(mailboxSignature.ok).toBe(true);
    if (!mailboxSignature.ok) return;

    const selected = await setComposeSignatureDefault({
      context: owner,
      mailboxId,
      senderIdentityId,
      input: { scope: "private", templateId: privateSignature.data.id, expectedRevision: null },
    });
    expect(selected.ok).toBe(true);

    const identityDefaults = await updateSenderIdentity({
      context: owner,
      mailboxId,
      senderIdentityId,
      input: {
        defaultCc: [
          { name: "Archive", address: "archive@example.test" },
          { name: null, address: "reader@example.test" },
          { name: "Cross-field duplicate", address: "duplicate@example.test" },
        ],
        defaultBcc: [
          { name: "Compliance", address: "compliance@example.test" },
          { name: null, address: "reader@example.test" },
          { name: "Hidden duplicate", address: "duplicate@example.test" },
        ],
        defaultFormat: "plain",
        defaultPriority: "high",
        defaultDeliveryReceipt: true,
        defaultReadReceipt: true,
        defaultSignatureTemplateId: mailboxSignature.data.id,
      },
    });
    expect(identityDefaults.ok).toBe(true);
    if (!identityDefaults.ok) return;
    expect(identityDefaults.data.defaultSignatureTemplateId).toBe(mailboxSignature.data.id);

    const [draftCountBeforeSeed] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mail.drafts
      WHERE mailbox_id = ${mailboxId}::uuid
    `;
    const seed = await prepareDraftSeed({
      context: owner,
      mailboxId,
      origin: {
        kind: "compose",
        input: {
          conversationId: null,
          intent: "new",
          sourceMessageId: null,
          senderIdentityId,
          to: [{ name: null, address: "reader@example.test" }],
          cc: [],
          bcc: [],
          subject: "Hello",
          body: "",
        },
      },
    });
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;
    expect(seed.data.content.body).toBe("");
    expect(seed.data.content.signatureTemplateId).toBe(privateSignature.data.id);
    const [draftCountAfterSeed] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mail.drafts
      WHERE mailbox_id = ${mailboxId}::uuid
    `;
    expect(draftCountAfterSeed?.count).toBe(draftCountBeforeSeed?.count);

    const draft = await createDraft({
      context: owner,
      mailboxId,
      input: {
        conversationId: null,
        intent: "new",
        sourceMessageId: null,
        senderIdentityId,
        to: [{ name: null, address: "reader@example.test" }],
        cc: [],
        bcc: [],
        subject: "Hello",
        body: "Message body",
      },
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.data.body).toBe("Message body");
    expect(draft.data.signatureTemplateId).toBe(privateSignature.data.id);
    expect(draft.data.cc).toEqual([
      { name: "Archive", address: "archive@example.test" },
      { name: "Cross-field duplicate", address: "duplicate@example.test" },
    ]);
    expect(draft.data.bcc).toEqual([{ name: "Compliance", address: "compliance@example.test" }]);
    expect(draft.data.format).toBe("plain");
    expect(draft.data.priority).toBe("high");
    expect(draft.data.requestDeliveryReceipt).toBe(true);
    expect(draft.data.requestReadReceipt).toBe(true);

    const collaboratorDraft = await createDraft({
      context: collaborator,
      mailboxId,
      input: {
        conversationId: null,
        intent: "new",
        sourceMessageId: null,
        senderIdentityId,
        to: [{ name: null, address: "reader@example.test" }],
        cc: [],
        bcc: [],
        subject: "Team hello",
        body: "Shared message body",
      },
    });
    expect(collaboratorDraft.ok).toBe(true);
    if (!collaboratorDraft.ok) return;
    expect(collaboratorDraft.data.body).toBe("Shared message body");
    expect(collaboratorDraft.data.signatureTemplateId).toBe(mailboxSignature.data.id);
    expect(collaboratorDraft.data.cc).toEqual([
      { name: "Archive", address: "archive@example.test" },
      { name: "Cross-field duplicate", address: "duplicate@example.test" },
    ]);
    expect(collaboratorDraft.data.bcc).toEqual([{ name: "Compliance", address: "compliance@example.test" }]);
    expect(collaboratorDraft.data.format).toBe("plain");
    expect(collaboratorDraft.data.priority).toBe("high");
    expect(collaboratorDraft.data.requestDeliveryReceipt).toBe(true);
    expect(collaboratorDraft.data.requestReadReceipt).toBe(true);
  });

  test("resolves snippets immediately and signatures only through preview", async () => {
    const templates = await listComposeTemplates(owner, mailboxId);
    expect(templates.ok).toBe(true);
    if (!templates.ok) return;
    const snippet = templates.data.find((template) => template.shortcut === "welcome");
    if (!snippet) throw new Error("Mailbox snippet is missing");
    const draft = {
      senderIdentityId,
      to: [{ name: null, address: "reader@example.test" }],
      cc: [],
      bcc: [],
      subject: "Welcome",
      body: `User text\n\n${markComposeTemplateSegment("Signed by {{ actor.display_name }}")}`,
      format: "markdown" as const,
    };
    const inserted = await renderComposeSnippet({
      context: collaborator,
      mailboxId,
      input: { templateId: snippet.id, draft, conversationId: null },
    });
    expect(inserted).toEqual({
      ok: true,
      data: { markdown: `Hello from Compose ${suffix}, Grace Writer (writer-${suffix}@example.test)` },
    });

    const suggestions = await renderComposeSuggestions({
      context: collaborator,
      mailboxId,
      input: { query: "wel", draft, conversationId: null },
    });
    expect(suggestions).toEqual({
      ok: true,
      data: [
        {
          templateId: snippet.id,
          name: "Welcome",
          shortcut: "welcome",
          kind: "snippet",
          markdown: `Hello from Compose ${suffix}, Grace Writer (writer-${suffix}@example.test)`,
        },
      ],
    });

    const preview = await previewComposeDraft({ context: collaborator, mailboxId, input: { draft, conversationId: null } });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.html).toContain("Grace Writer");
    expect(preview.data.text).toBe("User text\n\nSigned by Grace Writer");
  });

  test("lets a private shortcut override the same mailbox shortcut", async () => {
    const mailboxTemplate = await createComposeTemplate({
      context: owner,
      mailboxId,
      input: {
        kind: "snippet",
        scope: "mailbox",
        name: "Mailbox closing",
        shortcut: "closing",
        body: "Mailbox closing",
      },
    });
    expect(mailboxTemplate.ok).toBe(true);
    const privateTemplate = await createComposeTemplate({
      context: owner,
      mailboxId,
      input: {
        kind: "snippet",
        scope: "private",
        name: "Personal closing",
        shortcut: "closing",
        body: "Personal closing",
      },
    });
    expect(privateTemplate.ok).toBe(true);
    if (!mailboxTemplate.ok || !privateTemplate.ok) return;

    const draft = {
      senderIdentityId,
      to: [{ name: null, address: "reader@example.test" }],
      cc: [],
      bcc: [],
      subject: "",
      body: "",
      format: "markdown" as const,
    };
    const ownerSuggestions = await renderComposeSuggestions({
      context: owner,
      mailboxId,
      input: { query: "closing", draft, conversationId: null },
    });
    expect(ownerSuggestions).toMatchObject({
      ok: true,
      data: [{ templateId: privateTemplate.data.id, shortcut: "closing", markdown: "Personal closing" }],
    });
    const collaboratorSuggestions = await renderComposeSuggestions({
      context: collaborator,
      mailboxId,
      input: { query: "closing", draft, conversationId: null },
    });
    expect(collaboratorSuggestions).toMatchObject({
      ok: true,
      data: [{ templateId: mailboxTemplate.data.id, shortcut: "closing", markdown: "Mailbox closing" }],
    });
  });

  test("materializes delegated service-account signatures as the delegated user", async () => {
    const draft = {
      senderIdentityId,
      to: [{ name: null, address: "reader@example.test" }],
      cc: [],
      bcc: [],
      subject: "Delegated",
      body: markComposeTemplateSegment("Signed by {{ actor.display_name }} ({{ actor.email }})"),
      format: "markdown" as const,
    };
    const preview = await previewComposeDraft({
      context: delegatedContext(collaborator, delegatedServiceAccountId),
      mailboxId,
      input: { draft, conversationId: null },
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.text).toContain(`Signed by Grace Writer (writer-${suffix}@example.test)`);
  });

  test("fences revisions and rejects unsafe mailbox CSS", async () => {
    const templates = await listComposeTemplates(owner, mailboxId);
    expect(templates.ok).toBe(true);
    if (!templates.ok) return;
    const template = templates.data[0];
    if (!template) throw new Error("Compose template is missing");
    const updated = await updateComposeTemplate({
      context: owner,
      mailboxId,
      templateId: template.id,
      input: { expectedRevision: template.revision, name: `${template.name} updated` },
    });
    expect(updated.ok).toBe(true);
    const stale = await updateComposeTemplate({
      context: owner,
      mailboxId,
      templateId: template.id,
      input: { expectedRevision: template.revision, name: "Stale update" },
    });
    expect(stale).toMatchObject({ ok: false, error: { status: 409 } });

    const unsafe = await updateMailboxComposeStyle({
      context: owner,
      mailboxId,
      input: { expectedRevision: 1, customCss: "@import url(https://example.test/tracker.css);" },
    });
    expect(unsafe).toMatchObject({ ok: false, error: { status: 400 } });
    const safe = await updateMailboxComposeStyle({
      context: owner,
      mailboxId,
      input: { expectedRevision: 1, customCss: ".mail-content { color: #123456; }" },
    });
    expect(safe.ok).toBe(true);
  });

  test("serializes concurrent default updates", async () => {
    const templates = await listComposeTemplates(owner, mailboxId);
    expect(templates.ok).toBe(true);
    if (!templates.ok) return;
    const currentSignature = templates.data.find((template) => template.kind === "signature");
    if (!currentSignature) throw new Error("Compose signature is missing");
    const alternate = await createComposeTemplate({
      context: owner,
      mailboxId,
      input: {
        kind: "signature",
        scope: "private",
        name: "Alternate signature",
        shortcut: "alternate",
        body: "Thanks, {{ actor.display_name }}",
      },
    });
    expect(alternate.ok).toBe(true);
    if (!alternate.ok) return;
    const [current] = await sql<{ revision: string | number }[]>`
      SELECT revision
      FROM mail.compose_signature_defaults
      WHERE mailbox_id = ${mailboxId}::uuid
        AND sender_identity_id = ${senderIdentityDbId}::uuid
        AND user_id = ${owner.actor.kind === "user" ? owner.actor.user.id : ""}::uuid
    `;
    if (!current) throw new Error("Current signature default is missing");

    const results = await Promise.all([
      setComposeSignatureDefault({
        context: owner,
        mailboxId,
        senderIdentityId,
        input: { scope: "private", templateId: currentSignature.id, expectedRevision: Number(current.revision) },
      }),
      setComposeSignatureDefault({
        context: owner,
        mailboxId,
        senderIdentityId,
        input: { scope: "private", templateId: alternate.data.id, expectedRevision: Number(current.revision) },
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error.status === 409)).toHaveLength(1);
  });

  test("reports what email leaves out, keeps phone links, and lets mailbox CSS element rules win", async () => {
    const template = await createComposeTemplate({
      context: owner,
      mailboxId,
      input: { kind: "snippet", scope: "private", name: "Fine print", shortcut: "fineprint", body: "Note <small>fine print</small>" },
    });
    expect(template).toMatchObject({ ok: true, data: { formattingWarnings: [{ code: "unsupported_element", element: "small" }] } });
    if (!template.ok) return;
    const updatedTemplate = await updateComposeTemplate({
      context: owner,
      mailboxId,
      templateId: template.data.id,
      input: { expectedRevision: template.data.revision, body: "Plain **Markdown**" },
    });
    expect(updatedTemplate).toMatchObject({ ok: true, data: { formattingWarnings: [] } });
    const listed = await listComposeTemplates(owner, mailboxId);
    expect(listed.ok && listed.data.every((entry) => entry.formattingWarnings === undefined)).toBe(true);

    const content = {
      senderIdentityId,
      to: [{ name: null, address: "reader@example.test" }],
      cc: [],
      bcc: [],
      subject: "Formatting",
      body: 'Call [+49 731 000000](tel:+49731000000) or <span class="muted">write</span>.',
      format: "markdown" as const,
    };
    const draft = await createDraft({
      context: owner,
      mailboxId,
      input: { ...content, conversationId: null, intent: "new", sourceMessageId: null },
    });
    expect(draft).toMatchObject({
      ok: true,
      data: { formattingWarnings: [{ code: "unsupported_attribute", element: "span", attribute: "class" }] },
    });
    if (!draft.ok) return;
    const updatedDraft = await updateDraft({
      context: owner,
      mailboxId,
      draftId: draft.data.id,
      expectedRevision: draft.data.revision,
      input: { ...content, body: '<div style="color: #999">Quiet</div>' },
    });
    expect(updatedDraft).toMatchObject({
      ok: true,
      data: { formattingWarnings: [{ code: "unsupported_attribute", element: "div", attribute: "style" }] },
    });

    const style = await getMailboxComposeStyle(owner, mailboxId);
    if (!style.ok) throw new Error(style.error.message);
    const css = await updateMailboxComposeStyle({
      context: owner,
      mailboxId,
      input: { expectedRevision: style.data.revision, customCss: "a { color: #262626; }" },
    });
    expect(css.ok).toBe(true);
    const preview = await previewComposeDraft({ context: owner, mailboxId, input: { draft: content, conversationId: null } });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.html).toContain('href="tel:+49731000000"');
    expect(preview.data.html).toContain("color:#262626");
    expect(preview.data.html).not.toContain("#0f766e");
    expect(preview.data.formattingWarnings).toEqual([{ code: "unsupported_attribute", element: "span", attribute: "class" }]);
  });

  test("preview and send preserve the same extra Markdown blank lines", async () => {
    const draft: DraftEditableContentInput = {
      senderIdentityId,
      to: [{ name: null, address: "reader@example.test" }],
      cc: [],
      bcc: [],
      subject: "Blank lines",
      body: "Hello\n\n\n\nWorld",
      format: "markdown",
      signatureTemplateId: null,
    };
    const preview = await previewComposeDraft({ context: owner, mailboxId, input: { draft, conversationId: null } });
    if (!preview.ok) throw new Error(preview.error.message);
    const sent = await renderComposeDraft({
      mailboxId,
      draft,
      actor: actorRefFromRequest(owner),
      renderLiquid: true,
      logoSource: "cid",
    });
    if (!sent.ok) throw new Error(sent.error.message);
    expect(sent.data.html).toBe(preview.data.html);
    expect(sent.data.html?.match(/class="mail-blank-line"/g)).toHaveLength(2);
    expect(sent.data.text).toBe("Hello\n\n\n\nWorld");
    expect(sent.data.text).toBe(preview.data.text);
    expect(sent.data.logoUsed).toBe(false);
  });

  test("preview and send preserve the same Markdown dividers and dash underlines", async () => {
    const draft: DraftEditableContentInput = {
      senderIdentityId,
      to: [{ name: null, address: "reader@example.test" }],
      cc: [],
      bcc: [],
      subject: "Dividers",
      body: "Hello\n\n---\n\nWorld\n\na\n---\nb",
      format: "markdown",
      signatureTemplateId: null,
    };
    const preview = await previewComposeDraft({ context: owner, mailboxId, input: { draft, conversationId: null } });
    if (!preview.ok) throw new Error(preview.error.message);
    const sent = await renderComposeDraft({ mailboxId, draft, actor: actorRefFromRequest(owner), renderLiquid: true, logoSource: "cid" });
    if (!sent.ok) throw new Error(sent.error.message);
    expect(sent.data.html).toBe(preview.data.html);
    expect(sent.data.text).toBe(preview.data.text);
    expect(sent.data.html?.match(/<hr\b/g)).toHaveLength(2);
    expect(sent.data.html).not.toContain("<h2");
    expect(sent.data.text).toBe(`Hello\n\n${"-".repeat(40)}\n\nWorld\n\na\n\n${"-".repeat(40)}\n\nb`);
  });

  test("keeps rendering stored designs safe and available while saving stays strict", async () => {
    const customCss = String.raw`.mail-content { color: #123456; font-family: "\5FAE\8F6F\96C5\9ED1", sans-serif; }
h1 { background: image-set("https://example.test/a.png" 1x); font-size: 30px; }`;
    await sql`UPDATE mail.compose_styles SET custom_css = ${customCss} WHERE mailbox_id = ${mailboxId}::uuid`;
    const designWarnings: ComposeFormattingWarning[] = [
      { code: "ignored_mailbox_css", property: "font-family" },
      { code: "ignored_mailbox_css", property: "background" },
    ];
    const draft: DraftEditableContentInput = {
      senderIdentityId,
      to: [{ name: null, address: "reader@example.test" }],
      cc: [],
      bcc: [],
      subject: "Old design",
      body: "# Hello\n\n<small>Fine print</small>",
      format: "markdown",
    };
    const preview = await previewComposeDraft({ context: owner, mailboxId, input: { draft, conversationId: null } });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.html).toContain("color:#123456");
    expect(preview.data.html).toContain("font-size:30px");
    for (const removed of ["\\", "5FAE", "image-set", "example.test"]) expect(preview.data.html).not.toContain(removed);
    expect(preview.data.formattingWarnings).toEqual([...designWarnings, { code: "unsupported_element", element: "small" }]);
    for (const renderLiquid of [true, false]) {
      const rendered = await renderComposeDraft({ mailboxId, draft, actor: actorRefFromRequest(owner), renderLiquid, logoSource: "data" });
      expect(rendered).toEqual({
        ok: true,
        data: { logoUsed: false, inlineLogo: null, html: preview.data.html, text: preview.data.text, formattingWarnings: designWarnings },
      });
    }
    const capped = await previewComposeDraft({
      context: owner,
      mailboxId,
      input: {
        draft: { ...draft, body: Array.from({ length: 25 }, (_, i) => `<bad${i}>Text</bad${i}>`).join("\n") },
        conversationId: null,
      },
    });
    expect(capped.ok).toBe(true);
    if (!capped.ok) return;
    expect(capped.data.formattingWarnings).toHaveLength(MAX_COMPOSE_FORMATTING_WARNINGS);
    expect(capped.data.formattingWarnings.slice(0, 2)).toEqual(designWarnings);

    const style = await getMailboxComposeStyle(owner, mailboxId);
    expect(style.ok).toBe(true);
    if (!style.ok) return;
    expect(style.data.customCss).toBe(customCss);
    expect(style.data.formattingWarnings).toEqual(designWarnings);
    const rejected = await updateMailboxComposeStyle({
      context: owner,
      mailboxId,
      input: { expectedRevision: style.data.revision, customCss },
    });
    expect(rejected).toMatchObject({ ok: false, error: { status: 400, message: 'CSS value for "font-family" is not allowed' } });
    const fixed = await updateMailboxComposeStyle({
      context: owner,
      mailboxId,
      input: { expectedRevision: style.data.revision, customCss: ".mail-content { color: #123456; } h1 { font-size: 30px; }" },
    });
    expect(fixed).toMatchObject({ ok: true, data: { formattingWarnings: [] } });
  });

  test("previews and sends long messages with the built-in design when a valid stored design is too heavy", async () => {
    const customCss = Array.from(
      { length: 40 },
      (_, i) => `${i % 2 ? "p" : ".mail-content"} { color: #991abc; font-family: "Mailbox991${i}${"a".repeat(480)}"; }`,
    ).join("\n");
    const style = await getMailboxComposeStyle(owner, mailboxId);
    if (!style.ok) throw new Error(style.error.message);
    try {
      const saved = await updateMailboxComposeStyle({
        context: owner,
        mailboxId,
        input: { expectedRevision: style.data.revision, customCss },
      });
      expect(saved).toMatchObject({ ok: true, data: { formattingWarnings: [] } });
      if (!saved.ok) throw new Error(saved.error.message);
      const draft: DraftEditableContentInput = {
        senderIdentityId,
        to: [{ name: null, address: "reader@example.test" }],
        cc: [],
        bcc: [],
        subject: "Long message",
        body: `${Array.from({ length: 900 }, (_, i) => `Paragraph ${i}`).join("\n\n")}\n\n<small>Fine print</small>`,
        format: "markdown",
      };
      const preview = await previewComposeDraft({ context: owner, mailboxId, input: { draft, conversationId: null } });
      expect(preview).toMatchObject({ ok: true });
      if (!preview.ok) return;
      expect(preview.data.formattingWarnings).toEqual([{ code: "ignored_mailbox_css" }, { code: "unsupported_element", element: "small" }]);
      expect(preview.data.html).toContain("font-family:Arial");
      for (const value of ["#991abc", "Mailbox991"]) expect(preview.data.html).not.toContain(value);
      for (const renderLiquid of [true, false]) {
        const rendered = await renderComposeDraft({
          mailboxId,
          draft,
          actor: actorRefFromRequest(owner),
          renderLiquid,
          logoSource: "data",
        });
        expect(rendered).toEqual({
          ok: true,
          data: {
            logoUsed: false,
            inlineLogo: null,
            html: preview.data.html,
            text: preview.data.text,
            formattingWarnings: [{ code: "ignored_mailbox_css" }],
          },
        });
      }
    } finally {
      const current = await getMailboxComposeStyle(owner, mailboxId);
      if (!current.ok) throw new Error(current.error.message);
      const restored = await updateMailboxComposeStyle({
        context: owner,
        mailboxId,
        input: { expectedRevision: current.data.revision, customCss: style.data.customCss },
      });
      if (!restored.ok) throw new Error(restored.error.message);
    }
  });

  const newContent = () => ({ senderIdentityId, to: [], cc: [], bcc: [], subject: "", body: "" });

  const content = (draft: MailDraft): DraftEditableContent => ({
    senderIdentityId: draft.senderIdentityId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    format: draft.format,
    priority: draft.priority,
    requestDeliveryReceipt: draft.requestDeliveryReceipt,
    requestReadReceipt: draft.requestReadReceipt,
    signatureTemplateId: draft.signatureTemplateId,
  });

  const signature = async (shortcut: string, scope: "private" | "mailbox" = "mailbox") => {
    const result = await createComposeTemplate({
      context: owner,
      mailboxId,
      input: {
        kind: "signature",
        scope,
        name: shortcut,
        shortcut,
        body: `Regards ${shortcut} {{ actor.display_name }}`,
      },
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  };

  test("a saved design with a rejected value in a .mail-signature rule still previews and sends with the signature", async () => {
    const chosen = await signature("storeddesign");
    const [previous] = await sql<{ custom_css: string }[]>`
      SELECT custom_css FROM mail.compose_styles WHERE mailbox_id = ${mailboxId}::uuid
    `;
    if (!previous) throw new Error("Compose style is missing");
    try {
      const customCss = String.raw`.mail-signature { color: #52525b; font-family: "\5FAE", sans-serif; }`;
      await sql`UPDATE mail.compose_styles SET custom_css = ${customCss} WHERE mailbox_id = ${mailboxId}::uuid`;
      const draft = {
        ...newContent(),
        to: [{ name: null, address: "reader@example.test" }],
        body: "Answer",
        signatureTemplateId: chosen.id,
      };
      const preview = await previewComposeDraft({ context: owner, mailboxId, input: { draft } });
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.data.html).toContain('class="mail-signature"');
      expect(preview.data.html).toContain("Regards storeddesign Ada Owner");
      expect(preview.data.html).toMatch(/<div class="mail-signature" style="[^"]*color:#52525b/);
      expect(preview.data.html).not.toContain("5FAE");
      expect(preview.data.formattingWarnings[0]).toEqual({ code: "ignored_mailbox_css", property: "font-family" });
      const rendered = await renderComposeDraft({
        mailboxId,
        draft,
        actor: actorRefFromRequest(owner),
        renderLiquid: true,
        logoSource: "data",
      });
      expect(rendered).toEqual({
        ok: true,
        data: {
          logoUsed: false,
          inlineLogo: null,
          html: preview.data.html,
          text: preview.data.text,
          formattingWarnings: [{ code: "ignored_mailbox_css", property: "font-family" }],
        },
      });
    } finally {
      await sql`UPDATE mail.compose_styles SET custom_css = ${previous.custom_css} WHERE mailbox_id = ${mailboxId}::uuid`;
    }
  });

  test("explicit none and signature switching keep the body unchanged", async () => {
    const first = await signature("choicefirst");
    const second = await signature("choicesecond");
    const created = await createDraft({
      context: owner,
      mailboxId,
      input: { ...newContent(), body: "Body only  \n", signatureTemplateId: null },
    });
    if (!created.ok) throw new Error(created.error.message);
    expect(created.data).toMatchObject({ body: "Body only  \n", signatureTemplateId: null });
    let draft = created.data;
    for (const id of [first.id, second.id, null]) {
      const updated = await updateDraft({
        context: owner,
        mailboxId,
        draftId: draft.id,
        expectedRevision: draft.revision,
        input: { ...content(draft), signatureTemplateId: id },
      });
      if (!updated.ok) throw new Error(updated.error.message);
      expect(updated.data).toMatchObject({ body: "Body only  \n", signatureTemplateId: id });
      draft = updated.data;
    }
  });

  test("collaborators keep and preview the author's private signature but cannot select an arbitrary private signature", async () => {
    const chosen = await signature("privatechosen", "private");
    const unrelated = await signature("privateunrelated", "private");
    const created = await createDraft({
      context: owner,
      mailboxId,
      input: { ...newContent(), body: "Body", signatureTemplateId: chosen.id },
    });
    if (!created.ok) throw new Error(created.error.message);
    const { signatureTemplateId: _, ...withoutChoice } = content(created.data);
    const kept = await updateDraft({
      context: collaborator,
      mailboxId,
      draftId: created.data.id,
      expectedRevision: created.data.revision,
      input: withoutChoice,
    });
    if (!kept.ok) throw new Error(kept.error.message);
    expect(kept.data.signatureTemplateId).toBe(chosen.id);
    const unchanged = await updateDraft({
      context: collaborator,
      mailboxId,
      draftId: kept.data.id,
      expectedRevision: kept.data.revision,
      input: content(kept.data),
    });
    expect(unchanged).toMatchObject({ ok: true, data: { signatureTemplateId: chosen.id } });
    const preview = await previewComposeDraft({ context: collaborator, mailboxId, input: { draft: content(kept.data) } });
    expect(preview).toMatchObject({ ok: true, data: { text: "Body\n\nRegards privatechosen Grace Writer" } });
    for (const id of [unrelated.id, crypto.randomUUID()]) {
      const rejected = await createDraft({ context: collaborator, mailboxId, input: { ...newContent(), signatureTemplateId: id } });
      expect(rejected).toMatchObject({ ok: false, error: { message: "The selected signature is not available" } });
      const update = await updateDraft({
        context: collaborator,
        mailboxId,
        draftId: kept.data.id,
        expectedRevision: unchanged.ok ? unchanged.data.revision : kept.data.revision,
        input: { ...content(kept.data), signatureTemplateId: id },
      });
      expect(update).toMatchObject({ ok: false, error: { message: "The selected signature is not available" } });
      const preview = await previewComposeDraft({
        context: collaborator,
        mailboxId,
        input: { draft: { ...content(kept.data), signatureTemplateId: id } },
      });
      expect(preview).toMatchObject({ ok: false, error: { message: "The selected signature is not available" } });
    }
  });

  test("a private signature on an unreadable draft does not grant preview access", async () => {
    const chosen = await signature("unreadabledraft", "private");
    const created = await createDraft({
      context: owner,
      mailboxId,
      input: { ...newContent(), body: "Body", signatureTemplateId: chosen.id },
    });
    if (!created.ok) throw new Error(created.error.message);
    const accessId = accessIds[0];
    if (!accessId) throw new Error("Missing collaborator access");
    const limited = await updateMailboxAccess({ context: owner, mailboxId, accessId, permission: "write", scope: "assigned" });
    if (!limited.ok) throw new Error(limited.error.message);
    try {
      expect(await previewComposeDraft({ context: collaborator, mailboxId, input: { draft: content(created.data) } })).toMatchObject({
        ok: false,
        error: { message: "The selected signature is not available" },
      });
    } finally {
      const restored = await updateMailboxAccess({ context: owner, mailboxId, accessId, permission: "write", scope: "mailbox" });
      if (!restored.ok) throw new Error(restored.error.message);
    }
  });

  test("signature choices must belong to the draft mailbox", async () => {
    const other = await createMailbox(owner, { name: `Other compose ${suffix}` });
    if (!other.ok) throw new Error(other.error.message);
    try {
      const foreign = await createComposeTemplate({
        context: owner,
        mailboxId: other.data.id,
        input: { kind: "signature", scope: "mailbox", name: "Foreign", shortcut: "foreign", body: "Foreign signature" },
      });
      if (!foreign.ok) throw new Error(foreign.error.message);
      expect(
        await createDraft({ context: owner, mailboxId, input: { ...newContent(), signatureTemplateId: foreign.data.id } }),
      ).toMatchObject({ ok: false, error: { message: "The selected signature is not available" } });
      expect(
        await previewComposeDraft({
          context: owner,
          mailboxId,
          input: { draft: { senderIdentityId, signatureTemplateId: foreign.data.id } },
        }),
      ).toMatchObject({ ok: false, error: { message: "The selected signature is not available" } });
    } finally {
      const grants = await sql<
        { access_id: string }[]
      >`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${other.data.id}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${other.data.id}::uuid`;
      for (const grant of grants) await sql`DELETE FROM auth.access WHERE id = ${grant.access_id}::uuid`;
    }
  });

  test("archived signatures read as none and cannot be selected; snippet IDs are rejected", async () => {
    const chosen = await signature("archivedchoice");
    const created = await createDraft({
      context: owner,
      mailboxId,
      input: { ...newContent(), body: "Body", signatureTemplateId: chosen.id },
    });
    if (!created.ok) throw new Error(created.error.message);
    expect(
      (await archiveComposeTemplate({ context: owner, mailboxId, templateId: chosen.id, input: { expectedRevision: chosen.revision } })).ok,
    ).toBeTrue();
    expect(await getDraft(owner, mailboxId, created.data.id)).toMatchObject({
      ok: true,
      data: { signatureTemplateId: null, body: "Body" },
    });
    const templates = await listComposeTemplates(owner, mailboxId);
    if (!templates.ok) throw new Error(templates.error.message);
    const snippet = templates.data.find((template) => template.kind === "snippet");
    if (!snippet) throw new Error("Missing snippet");
    for (const id of [chosen.id, snippet.id]) {
      expect(await createDraft({ context: owner, mailboxId, input: { ...newContent(), signatureTemplateId: id } })).toMatchObject({
        ok: false,
        error: { message: "The selected signature is not available" },
      });
      expect(
        await previewComposeDraft({ context: owner, mailboxId, input: { draft: { senderIdentityId, signatureTemplateId: id } } }),
      ).toMatchObject({ ok: false, error: { message: "The selected signature is not available" } });
    }
  });

  test("materialization resolves omission and lets the client choose another signature or none", async () => {
    const chosen = await signature("materializedchoice");
    const origin = {
      kind: "compose" as const,
      input: { ...newContent(), to: [], cc: [], bcc: [], subject: "", body: "", includeSourceAttachments: false },
    };
    const seed = await prepareDraftSeed({ context: owner, mailboxId, origin });
    if (!seed.ok) throw new Error(seed.error.message);
    expect(seed.data.content.signatureTemplateId).not.toBeNull();
    for (const choice of [{}, { signatureTemplateId: null }, { signatureTemplateId: chosen.id }]) {
      const draft = await materializeDraftSeed({
        context: owner,
        mailboxId,
        input: {
          idempotencyKey: crypto.randomUUID(),
          origin,
          draft: { ...seed.data.content, body: "Client body", signatureTemplateId: undefined, ...choice },
        },
      });
      expect(draft).toMatchObject({
        ok: true,
        data: {
          body: "Client body",
          signatureTemplateId: "signatureTemplateId" in choice ? choice.signatureTemplateId : seed.data.content.signatureTemplateId,
        },
      });
    }
  });

  test("suggestions contain only snippets and signatures cannot be inserted", async () => {
    const chosen = await signature("notinsertable");
    const draft = { senderIdentityId, body: "Body", format: "markdown" as const };
    const suggestions = await renderComposeSuggestions({ context: owner, mailboxId, input: { query: "", draft } });
    expect(suggestions.ok).toBeTrue();
    if (!suggestions.ok) throw new Error(suggestions.error.message);
    expect(suggestions.data.every((template) => template.kind === "snippet")).toBeTrue();
    expect(await renderComposeSuggestions({ context: owner, mailboxId, input: { query: "notinsertable", draft } })).toEqual({
      ok: true,
      data: [],
    });
    expect(await renderComposeSnippet({ context: owner, mailboxId, input: { templateId: chosen.id, draft } })).toMatchObject({
      ok: false,
      error: { message: "Signatures are not inserted into the body; choose one with signatureTemplateId on the draft" },
    });
  });

  test("legacy drafts migrate on open without a write and persist the migrated view on save", async () => {
    const chosen = await signature("migratedchoice");
    const body = `Answer\n\n${markComposeTemplateSegment(chosen.body)}\n\nAda wrote:\n> History`;
    const created = await createDraft({ context: owner, mailboxId, input: { ...newContent(), body, signatureTemplateId: null } });
    if (!created.ok) throw new Error(created.error.message);
    const opened = await getDraft(owner, mailboxId, created.data.id);
    expect(opened).toMatchObject({
      ok: true,
      data: { body: "Answer\n\nAda wrote:\n> History", signatureTemplateId: chosen.id, revision: created.data.revision },
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const [stored] = await sql<
      { body_markdown: string; signature_template_id: string | null }[]
    >`SELECT body_markdown, signature_template_id FROM mail.drafts WHERE id = ${created.data.id}::uuid`;
    expect(stored).toEqual({ body_markdown: body, signature_template_id: null });
    const saved = await updateDraft({
      context: owner,
      mailboxId,
      draftId: opened.data.id,
      expectedRevision: opened.data.revision,
      input: content(opened.data),
    });
    expect(saved).toMatchObject({ ok: true, data: { body: opened.data.body, signatureTemplateId: chosen.id } });
    const [persisted] = await sql<
      { body_markdown: string; signature_template_id: string | null }[]
    >`SELECT body_markdown, signature_template_id FROM mail.drafts WHERE id = ${created.data.id}::uuid`;
    expect(persisted).toEqual({ body_markdown: opened.data.body, signature_template_id: chosen.id });
  });

  test("saving an old client body strips the legacy signature and omission preserves its effective choice", async () => {
    const chosen = await signature("oldclientchoice");
    const body = `Answer\n\n${markComposeTemplateSegment(chosen.body)}`;
    const created = await createDraft({ context: owner, mailboxId, input: { ...newContent(), body, signatureTemplateId: null } });
    if (!created.ok) throw new Error(created.error.message);
    const { signatureTemplateId: _, ...withoutChoice } = content(created.data);
    const saved = await updateDraft({
      context: owner,
      mailboxId,
      draftId: created.data.id,
      expectedRevision: created.data.revision,
      input: withoutChoice,
    });
    expect(saved).toMatchObject({ ok: true, data: { body: "Answer", signatureTemplateId: chosen.id } });
    if (!saved.ok) throw new Error(saved.error.message);
    const cleared = await updateDraft({
      context: owner,
      mailboxId,
      draftId: saved.data.id,
      expectedRevision: saved.data.revision,
      input: { ...content(saved.data), body, signatureTemplateId: null },
    });
    expect(cleared).toMatchObject({ ok: true, data: { body, signatureTemplateId: null } });
    const [storedCleared] = await sql<{ body: string; signature: string | null }[]>`
      SELECT body_markdown AS body, signature_template_id AS signature FROM mail.drafts WHERE id = ${saved.data.id}::uuid
    `;
    expect(storedCleared).toEqual({ body, signature: null });
    // A client that already removed the segment but omits the new field keeps the stored body's choice.
    const old = await createDraft({ context: owner, mailboxId, input: { ...newContent(), body, signatureTemplateId: null } });
    if (!old.ok) throw new Error(old.error.message);
    expect(
      await updateDraft({
        context: owner,
        mailboxId,
        draftId: old.data.id,
        expectedRevision: old.data.revision,
        input: { ...withoutChoice, body: "Edited answer" },
      }),
    ).toMatchObject({ ok: true, data: { body: "Edited answer", signatureTemplateId: chosen.id } });
  });

  test("recovery copies restore explicit choices and keep the current choice for old copies", async () => {
    const first = await signature("recoveryfirst");
    const second = await signature("recoverysecond");
    const created = await createDraft({ context: owner, mailboxId, input: { ...newContent(), signatureTemplateId: first.id } });
    if (!created.ok) throw new Error(created.error.message);
    const current = await updateDraft({
      context: owner,
      mailboxId,
      draftId: created.data.id,
      expectedRevision: created.data.revision,
      input: content(created.data),
    });
    if (!current.ok) throw new Error(current.error.message);
    const { signatureTemplateId: _, ...oldContent } = content(current.data);
    for (const choice of [{ signatureTemplateId: second.id }, {}, { signatureTemplateId: null }]) {
      const conflict = await updateDraft({
        context: owner,
        mailboxId,
        draftId: created.data.id,
        expectedRevision: created.data.revision,
        input: { ...oldContent, ...choice },
      });
      expect(conflict).toMatchObject({ ok: false, error: { status: 409 } });
    }
    const copies = await listDraftRecoveryCopies({ context: owner, mailboxId, draftId: created.data.id });
    if (!copies.ok) throw new Error(copies.error.message);
    const chosen = copies.data.find((copy) => copy.content.signatureTemplateId === second.id);
    const old = copies.data.find((copy) => !Object.hasOwn(copy.content, "signatureTemplateId"));
    const none = copies.data.find((copy) => copy.content.signatureTemplateId === null);
    if (!chosen || !old || !none) throw new Error("Missing signature recovery copies");
    const lease = await acquireDraftLease({ context: owner, mailboxId, draftId: created.data.id });
    if (!lease.ok) throw new Error(lease.error.message);
    let revision = current.data.revision;
    try {
      for (const [copy, expected] of [
        [chosen, second.id],
        [old, second.id],
        [none, null],
      ] as const) {
        const restored = await restoreDraftRecoveryCopy({
          context: owner,
          mailboxId,
          draftId: created.data.id,
          recoveryCopyId: copy.id,
          expectedRevision: revision,
          leaseToken: lease.data.token,
        });
        expect(restored).toMatchObject({ ok: true, data: { signatureTemplateId: expected } });
        if (!restored.ok) throw new Error(restored.error.message);
        revision = restored.data.revision;
      }
    } finally {
      await releaseDraftLease({ context: owner, mailboxId, draftId: created.data.id, token: lease.data.token });
    }
  });

  test("saving two legacy segments keeps the first choice and the other segment", async () => {
    const first = await signature("legacyfirst");
    const second = await signature("legacysecond");
    const body = `Answer\n\n${markComposeTemplateSegment(first.body)}\n\n${markComposeTemplateSegment(second.body)}`;
    const expectedBody = `Answer\n\n${markComposeTemplateSegment(second.body)}`;
    for (const omitChoice of [false, true]) {
      const created = await createDraft({ context: owner, mailboxId, input: { ...newContent(), body, signatureTemplateId: null } });
      if (!created.ok) throw new Error(created.error.message);
      const view = await getDraft(owner, mailboxId, created.data.id);
      if (!view.ok) throw new Error(view.error.message);
      expect(view.data).toMatchObject({ body: expectedBody, signatureTemplateId: first.id });
      const { signatureTemplateId: _, ...withoutChoice } = content(view.data);
      const saved = await updateDraft({
        context: owner,
        mailboxId,
        draftId: view.data.id,
        expectedRevision: view.data.revision,
        input: omitChoice ? withoutChoice : content(view.data),
      });
      expect(saved).toMatchObject({ ok: true, data: { body: expectedBody, signatureTemplateId: first.id } });
      const [stored] = await sql<{ body: string; signature: string | null }[]>`
        SELECT body_markdown AS body, signature_template_id AS signature FROM mail.drafts WHERE id = ${view.data.id}::uuid
      `;
      expect(stored).toEqual({ body: expectedBody, signature: first.id });
    }
  });

  test("recovery rejects another user's private signature saved by a stale collaborator", async () => {
    const chosen = await signature("restorechosen");
    const privateSignature = await signature("restoreprivate", "private");
    const created = await createDraft({ context: owner, mailboxId, input: { ...newContent(), signatureTemplateId: chosen.id } });
    if (!created.ok) throw new Error(created.error.message);
    const current = await updateDraft({
      context: owner,
      mailboxId,
      draftId: created.data.id,
      expectedRevision: created.data.revision,
      input: content(created.data),
    });
    if (!current.ok) throw new Error(current.error.message);
    expect(
      await updateDraft({
        context: collaborator,
        mailboxId,
        draftId: current.data.id,
        expectedRevision: created.data.revision,
        input: { ...content(current.data), signatureTemplateId: privateSignature.id },
      }),
    ).toMatchObject({ ok: false, error: { status: 409 } });
    const copies = await listDraftRecoveryCopies({ context: collaborator, mailboxId, draftId: current.data.id });
    if (!copies.ok) throw new Error(copies.error.message);
    const copy = copies.data[0];
    if (!copy) throw new Error("Missing private signature recovery copy");
    expect(copy.content.signatureTemplateId).toBe(privateSignature.id);
    const lease = await acquireDraftLease({ context: collaborator, mailboxId, draftId: current.data.id });
    if (!lease.ok) throw new Error(lease.error.message);
    try {
      expect(
        await restoreDraftRecoveryCopy({
          context: collaborator,
          mailboxId,
          draftId: current.data.id,
          recoveryCopyId: copy.id,
          expectedRevision: current.data.revision,
          leaseToken: lease.data.token,
        }),
      ).toMatchObject({ ok: false, error: { status: 400, message: "The selected signature is not available" } });
      const [stored] = await sql<{ signature: string | null; restored_at: Date | null }[]>`
        SELECT d.signature_template_id AS signature, recovery.restored_at
        FROM mail.drafts d JOIN mail.draft_recovery_copies recovery ON recovery.draft_id = d.id
        WHERE recovery.id = ${copy.id}::uuid
      `;
      expect(stored).toEqual({ signature: chosen.id, restored_at: null });
    } finally {
      await releaseDraftLease({ context: collaborator, mailboxId, draftId: current.data.id, token: lease.data.token });
    }
  });

  test("restoring an old recovery body removes only the stored signature's segment", async () => {
    const chosen = await signature("restorelegacy");
    const other = await signature("restoreother");
    const created = await createDraft({ context: owner, mailboxId, input: { ...newContent(), signatureTemplateId: chosen.id } });
    if (!created.ok) throw new Error(created.error.message);
    const current = await updateDraft({
      context: owner,
      mailboxId,
      draftId: created.data.id,
      expectedRevision: created.data.revision,
      input: content(created.data),
    });
    if (!current.ok) throw new Error(current.error.message);
    const { signatureTemplateId: _, ...oldContent } = content(current.data);
    const expectedBody = `Recovered answer\n\n${markComposeTemplateSegment(other.body)}`;
    expect(
      await updateDraft({
        context: owner,
        mailboxId,
        draftId: current.data.id,
        expectedRevision: created.data.revision,
        input: { ...oldContent, body: `${expectedBody}\n\n${markComposeTemplateSegment(chosen.body)}` },
      }),
    ).toMatchObject({ ok: false, error: { status: 409 } });
    const copies = await listDraftRecoveryCopies({ context: owner, mailboxId, draftId: current.data.id });
    if (!copies.ok) throw new Error(copies.error.message);
    const copy = copies.data[0];
    if (!copy) throw new Error("Missing legacy recovery copy");
    expect(Object.hasOwn(copy.content, "signatureTemplateId")).toBeFalse();
    const lease = await acquireDraftLease({ context: owner, mailboxId, draftId: current.data.id });
    if (!lease.ok) throw new Error(lease.error.message);
    try {
      expect(
        await restoreDraftRecoveryCopy({
          context: owner,
          mailboxId,
          draftId: current.data.id,
          recoveryCopyId: copy.id,
          expectedRevision: current.data.revision,
          leaseToken: lease.data.token,
        }),
      ).toMatchObject({ ok: true, data: { body: expectedBody, signatureTemplateId: chosen.id } });
      const [stored] = await sql<{ body: string; signature: string | null }[]>`
        SELECT body_markdown AS body, signature_template_id AS signature FROM mail.drafts WHERE id = ${current.data.id}::uuid
      `;
      expect(stored).toEqual({ body: expectedBody, signature: chosen.id });
    } finally {
      await releaseDraftLease({ context: owner, mailboxId, draftId: current.data.id, token: lease.data.token });
    }
  });

  test("materializing an old compose seed removes the default signature's segment", async () => {
    const origin = { kind: "compose" as const, input: newContent() };
    const seed = await prepareDraftSeed({ context: owner, mailboxId, origin });
    if (!seed.ok) throw new Error(seed.error.message);
    const templates = await listComposeTemplates(owner, mailboxId);
    if (!templates.ok) throw new Error(templates.error.message);
    const chosen = templates.data.find((template) => template.id === seed.data.content.signatureTemplateId);
    if (!chosen) throw new Error("Missing default signature");
    const { signatureTemplateId: _, ...oldContent } = seed.data.content;
    const draft = await materializeDraftSeed({
      context: owner,
      mailboxId,
      input: {
        origin,
        idempotencyKey: crypto.randomUUID(),
        draft: { ...oldContent, body: `Answer\n\n${markComposeTemplateSegment(chosen.body)}` },
      },
    });
    expect(draft).toMatchObject({ ok: true, data: { body: "Answer", signatureTemplateId: chosen.id } });
    if (!draft.ok) throw new Error(draft.error.message);
    const [stored] = await sql<{ body: string; signature: string | null }[]>`
      SELECT body_markdown AS body, signature_template_id AS signature FROM mail.drafts WHERE id = ${draft.data.id}::uuid
    `;
    expect(stored).toEqual({ body: "Answer", signature: chosen.id });
  });

  test("preview renders a selected signature only once when its segment remains in the body", async () => {
    const chosen = await signature("previewlegacy");
    const preview = await previewComposeDraft({
      context: owner,
      mailboxId,
      input: { draft: { ...newContent(), signatureTemplateId: chosen.id, body: `Answer\n\n${markComposeTemplateSegment(chosen.body)}` } },
    });
    if (!preview.ok) throw new Error(preview.error.message);
    expect(preview.data.text).toBe("Answer\n\nRegards previewlegacy Ada Owner");
    expect(preview.data.html.match(/Regards previewlegacy/g)).toHaveLength(1);
  });
});
