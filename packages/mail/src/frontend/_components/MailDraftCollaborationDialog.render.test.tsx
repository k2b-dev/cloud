import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { DraftLease } from "../../contracts";
import type { MailDraftCollaborationChoice } from "./MailDraftCollaborationDialog";

const root = mkdtempSync(join(tmpdir(), "mail-draft-collaboration-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { MailDraftCollaborationDialog, mailDraftCollaborationCopy } = await import("./MailDraftCollaborationDialog.tsx");

const lease: DraftLease = {
  holder: {
    kind: "user",
    id: "10000000-0000-4000-8000-000000000001",
    displayName: "Ada Lovelace",
    avatarHash: "avatar-revision",
  },
  acquiredAt: "2026-08-18T12:00:00.000Z",
  expiresAt: "2026-08-18T12:00:30.000Z",
};

const dateConfig = { locale: "en", timeZone: "UTC" };

describe("MailDraftCollaborationDialog", () => {
  test("distinguishes the current user's other tab", () => {
    const copy = mailDraftCollaborationCopy({ lease, reason: "occupied" }, { kind: "user", id: lease.holder.id });
    expect(copy.title).toBe("Draft open in another tab");
    expect(copy.status).toBe("You are editing this draft in another tab.");
    expect(copy.takeoverLabel).toBe("Edit in this tab");
  });

  test("explains when the current user's lease was taken over", () => {
    const copy = mailDraftCollaborationCopy({ lease, reason: "lost" }, { kind: "user", id: lease.holder.id });
    expect(copy.description).toContain("Another tab or window took over editing");
    expect(copy.takeoverLabel).toBe("Edit in this tab");
  });

  test("names another collaborator and explains the safe takeover consequence", () => {
    const copy = mailDraftCollaborationCopy({ lease, reason: "lost" }, { kind: "user", id: "20000000-0000-4000-8000-000000000002" });
    expect(copy.title).toBe("Ada Lovelace is editing this draft");
    expect(copy.description).toContain("makes their editor read-only");
    expect(copy.takeoverLabel).toBe("Take over");
  });

  test("falls back safely when holder details are unavailable", () => {
    const copy = mailDraftCollaborationCopy(
      { lease: null, reason: "occupied" },
      { kind: "user", id: "20000000-0000-4000-8000-000000000002" },
    );
    expect(copy).toMatchObject({
      title: "Draft open elsewhere",
      status: "This draft is currently being edited elsewhere.",
      takeoverLabel: "Try editing here",
    });
  });

  test("renders holder metadata and two native, responsive choices", () => {
    const choices: MailDraftCollaborationChoice[] = [];
    const html = renderToString(() =>
      createComponent(MailDraftCollaborationDialog, {
        conflict: { lease, reason: "occupied" },
        currentActor: { kind: "user", id: "20000000-0000-4000-8000-000000000002" },
        dateConfig,
        close: (choice) => choices.push(choice),
      }),
    );

    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("avatar-revision");
    expect(html).toContain('datetime="2026-08-18T12:00:00.000Z"');
    expect(html).toContain("View read-only");
    expect(html).toContain("Take over");
    expect(html).toContain("flex-wrap-reverse");
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(choices).toEqual([]);
  });

  test("recognizes the same service account session by actor kind and id", () => {
    const serviceLease: DraftLease = {
      ...lease,
      holder: {
        kind: "service_account",
        id: "30000000-0000-4000-8000-000000000003",
        displayName: "Mail automation",
        avatarHash: null,
      },
    };

    const copy = mailDraftCollaborationCopy(
      { lease: serviceLease, reason: "occupied" },
      { kind: "service_account", id: serviceLease.holder.id },
    );
    expect(copy.title).toBe("Draft open in another tab");
    expect(copy.takeoverLabel).toBe("Edit in this tab");

    const userWithSameId = mailDraftCollaborationCopy(
      { lease: serviceLease, reason: "occupied" },
      { kind: "user", id: serviceLease.holder.id },
    );
    expect(userWithSameId.title).toBe("Mail automation is editing this draft");
  });
});
