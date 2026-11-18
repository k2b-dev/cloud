import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AiTurnBlock } from "@k2b/cloud/ai";
import { actionCardText, approvalCard } from "@k2b/cloud/ai/question-text";
import type { CapabilityActionCallReview } from "@k2b/cloud/contracts";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../ui/test/ssr-test-plugin";
import { buildSendReview, draftPreview, mailActionReviews, reviewObject, type SendReviewSource } from "./capability-reviews";

const root = mkdtempSync(resolve(tmpdir(), "mail-review-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { AiTurnBlockView, AiChatActionsProvider } = await import("@k2b/cloud/ai/ui");
const { LocaleProvider } = await import("@k2b/ui");
const { ApprovalDetails } = await import("@k2b/cloud/approvals/ui");

const source: SendReviewSource = {
  contentHash: "a".repeat(64),
  draft: {
    subject: "Update",
    body: "Hello Lea,\nThe maintenance window is confirmed.\n\nValentin",
    format: "plain",
    to: [{ name: "Lea Berg", address: "lea@example.com" }],
    cc: [{ name: "Mira", address: "mira@example.com" }],
    bcc: [{ name: "Tom", address: "tom@example.com" }],
    attachments: [
      { filename: "plan.pdf", byteLength: 84000 },
      { filename: "calendar.ics", byteLength: 128 },
    ],
  },
  from: { name: "Valentin", address: "valentin@example.com" },
  mailboxId: "MbA123",
  draftId: "DrA123",
  expectedRevision: 7,
  href: "/app/mail/MbA123/drafts/DrA123",
  warnings: [],
};
const blockFor = (review: CapabilityActionCallReview, action: string): AiTurnBlock => ({
  id: "mail-call",
  kind: "tool",
  callId: "mail-call",
  name: `mail.${action}`,
  status: "awaiting_approval",
  review,
  approval: { allowAlways: false, allowChat: false },
  presentation: { kind: "capability", appId: "mail", appName: "Mail", appIcon: "ti ti-mail", title: "Send mail", capabilityKind: "action" },
});
const renderReview = (review: CapabilityActionCallReview, action = "draft.send") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: review.locale,
      get children() {
        return createComponent(AiChatActionsProvider, {
          actions: { onApproval: async () => undefined },
          get children() {
            return createComponent(AiTurnBlockView, { block: blockFor(review, action), turnId: "turn", active: true });
          },
        });
      },
    }),
  );
// The compact card defers the complete proposal; its public renderer still shows every review fact in the dialog.
const renderDetails = (review: CapabilityActionCallReview, action = "draft.send") =>
  renderToString(() =>
    createComponent(ApprovalDetails, {
      card: approvalCard({ review, sentence: "", action, appName: "Mail" }, review.locale, "UTC"),
    }),
  );
const visibleText = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("Mail reviews through the public Cloud card renderer", () => {
  for (const locale of ["de", "en"])
    for (const scheduled of [false, true])
      test(`${locale}: ${scheduled ? "scheduled" : "immediate"} send`, () => {
        const warning =
          locale === "de"
            ? { title: "1 externer Empfänger.", description: "Diese E-Mail verlässt die für das Postfach festgelegten internen Domains." }
            : { title: "1 external recipient.", description: "This email leaves the internal domains set for the mailbox." };
        const review = buildSendReview(
          { ...source, scheduledAt: scheduled ? "2026-10-20T06:00:00.000Z" : undefined, warnings: [warning] },
          locale,
        );
        const html = renderReview(review);
        const text = visibleText(html);
        const details = renderDetails(review);
        const detailText = visibleText(details);
        expect(html).toContain(`aria-label="${locale === "de" ? "Freigabe" : "Approval"} · Mail"`);
        expect(text).toContain(locale === "de" ? "Alles ansehen" : "See everything");
        expect(html).not.toContain("cloud-action-details");
        for (const address of ["valentin@example.com", "lea@example.com", "mira@example.com", "tom@example.com"])
          expect(details).toContain(address);
        for (const label of [locale === "de" ? "Von" : "From", locale === "de" ? "An" : "To", "Cc", "Bcc"])
          expect(detailText).toContain(label);
        expect(text).toMatch(locale === "de" ? /Mail Update an (?:LB )?Lea Berg/ : /Send the email Update to (?:LB )?Lea Berg/);
        expect(text).toContain("Update");
        expect(text).toContain("Lea Berg");
        expect(details).toContain("k2b-reference");
        expect(detailText).toContain("plan.pdf");
        expect(detailText).toContain("calendar.ics");
        expect(detailText).toContain(warning.title);
        expect(detailText).toContain(warning.description);
        expect(review.sentence.confirm).toBe(locale === "de" ? "Senden" : "Send");
        expect(text).toContain(locale === "de" ? "Senden" : "Send");
        expect(text).toContain(locale === "de" ? "Nicht senden" : "Don't send");
        if (scheduled) expect(details).toContain("2026-10-20T06:00:00.000Z");
        const plain = actionCardText(approvalCard({ review, sentence: "", action: "draft.send", appName: "Mail" }, locale, "UTC"));
        for (const address of ["valentin@example.com", "lea@example.com", "mira@example.com", "tom@example.com"])
          expect(JSON.stringify(plain)).toContain(address);
      });
  for (const locale of ["de", "en"])
    test(`${locale}: irreversible draft deletion`, () => {
      const review = mailActionReviews["draft.discard"](
        locale,
        { draft: reviewObject("Update", { type: "mail.draft", id: source.draftId }) },
        { view: draftPreview(source.draft, locale), links: [{ rel: "open", href: source.href }] },
      );
      const html = renderReview(review, "draft.discard");
      const text = visibleText(html);
      expect(text).toContain(locale === "de" ? "Update löschen" : "Delete Update");
      expect(text).toContain(locale === "de" ? "Behalten" : "Keep it");
      expect(text).toContain(locale === "de" ? "nicht zurückholen" : "can't bring it back");
      expect(renderDetails(review, "draft.discard")).toContain("plan.pdf");
      expect(text).not.toContain(locale === "de" ? "gesendet" : "sent");
    });
});
