import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { markComposeTemplateSegment } from "./compose-renderer";
import {
  createComposeTemplate,
  listComposeTemplates,
  previewComposeDraft,
  renderComposeSnippet,
  renderComposeSuggestions,
  setComposeSignatureDefault,
  updateComposeTemplate,
  updateMailboxComposeStyle,
} from "./compose-templates";
import { createDraft, prepareDraftSeed } from "./drafts";
import { createMailbox } from "./mailboxes";
import { updateSenderIdentity } from "./sender-identities";

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

  test("keeps private templates private and inserts one default signature source", async () => {
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
        body: "Hello from {{ mailbox.name }}, {{ actor.display_name }}",
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

    const signatureSource = markComposeTemplateSegment("Regards,\n{{ actor.display_name }}");
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
    expect(seed.data.content.body).toBe(signatureSource);
    expect(seed.data.initialSignatureSource).toBe(signatureSource);
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
    expect(draft.data.body).toBe(`Message body\n\n${signatureSource}`);
    expect(draft.data.initialSignatureSource).toBe(signatureSource);
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
    const mailboxSignatureSource = markComposeTemplateSegment("Team regards,\n{{ actor.display_name }}");
    expect(collaboratorDraft.data.body).toBe(`Shared message body\n\n${mailboxSignatureSource}`);
    expect(collaboratorDraft.data.initialSignatureSource).toBe(mailboxSignatureSource);
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
    expect(inserted).toEqual({ ok: true, data: { markdown: `Hello from Compose ${suffix}, Grace Writer` } });

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
          markdown: `Hello from Compose ${suffix}, Grace Writer`,
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
});
