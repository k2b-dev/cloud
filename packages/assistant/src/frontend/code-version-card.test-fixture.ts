import type { CodeVersionCardLoaded } from "./code-version-card-state";
import { describeCodeVersionCard } from "./code-version-card-state";

export const approvalNow = "2026-11-17T08:49:00.000Z";
export const approvalVersionId = "66666666-6666-4666-8666-666666666666";
export const approvalStates = [
  "waiting",
  "changes",
  "revising",
  "rejected",
  "expired",
  "ready",
  "switching",
  "activation-failed",
  "on",
  "on-without-page",
  "paused",
  "replaced",
] as const;
export type ApprovalState = (typeof approvalStates)[number];

/** Fictional data at the same public transport boundary as the chat card. No page discovery in this fixture. */
export function approvalFixture(state: ApprovalState, locale = "de"): CodeVersionCardLoaded {
  const de = locale === "de";
  const versionId = approvalVersionId;
  const value: CodeVersionCardLoaded = {
    preview: {
      codeId: "c_info01",
      versionId,
      number: 1,
      latest: 1,
      running: null,
      title: de ? "Lieferscheine ablegen" : "File delivery notes",
      ownerKind: "person",
      activated: null,
      allowed: { allowed: true },
      readiness: { state: "ready" },
      place: null,
    },
    review: {
      status: "approved",
      origin: { kind: "ai_chat", conversationId: "chat-1", automaticAfterReview: false },
      decidedBy: { id: "u-jana", name: "Jana Probe", avatarHash: null },
      decidedAt: "2026-11-17T08:30:00.000Z",
      message: null,
      comments: [],
      commentCount: 0,
      activeVersion: null,
    },
    words: {
      versionId,
      number: 1,
      submittedAt: "2026-11-17T08:00:00.000Z",
      locale,
      description: { state: "visible", text: null, modelLabel: "" },
      assurance: "",
      mayDo: {
        items: [{ text: de ? "liest Mails" : "reads mail" }, { text: de ? "legt Dateien ab" : "stores files" }],
        more: 0,
        moreText: null,
      },
      timing: { items: [{ text: de ? "stündlich" : "hourly" }], more: 0, moreText: null },
      changes: { state: "first", text: "", rows: { items: [], more: 0, moreText: null }, assurance: "" },
      examples: { state: "passed", passed: 2, total: 2, summary: "", explanation: "", items: [] },
      notices: { items: [], more: 0, moreText: null },
    },
    code: { state: "draft", activeVersionId: null },
    pages: { versionId, homeUrl: null, pages: [] },
    latest: null,
  };
  const review = value.review!;
  if (state === "waiting") {
    review.status = "pending";
    value.preview.readiness = { state: "approval_pending" };
  }
  if (state === "changes" || state === "revising") {
    review.status = "changes_requested";
    review.message = de ? "Bitte nur PDF-Anhänge ablegen." : "Please store only PDF attachments.";
    review.commentCount = 2;
    if (state === "revising") review.revision = { state: "running", reason: null };
  }
  if (state === "rejected") {
    review.status = "rejected";
    review.message = de ? "Bitte nicht in einen Ordner, den alle sehen." : "Please avoid a folder everyone can see.";
  }
  if (state === "expired") review.status = "expired";
  if (state === "on" || state === "on-without-page" || state === "paused") {
    value.preview.running = 1;
    value.preview.activated = { at: "2026-11-17T08:35:00.000Z", byYou: true, byName: null };
    value.code = {
      state: state === "paused" ? "paused" : "active",
      activeVersionId: versionId,
      pausedAt: state === "paused" ? "2026-11-12T08:35:00.000Z" : null,
      pausedBy: state === "paused" ? { name: "Lea Muster" } : null,
    };
    if (state === "on")
      value.pages = {
        versionId,
        homeUrl: "/code/c_info01/home",
        pages: [
          { entrypoint: "home.ts", title: "Lieferscheine", isRoot: true, path: "/home", href: "/code/c_info01/home" },
          { entrypoint: "months.ts", title: "Monatsübersicht", isRoot: false, path: "/months", href: "/code/c_info01/months" },
          { entrypoint: "settings.ts", title: "Einstellungen", isRoot: false, path: "/settings", href: "/code/c_info01/settings" },
        ],
      };
  }
  if (state === "replaced") {
    value.preview.latest = 2;
    value.latest = { id: "77777777-7777-4777-8777-777777777777", number: 2 };
  }
  return value;
}

export function approvalModel(state: ApprovalState, locale = "de") {
  return describeCodeVersionCard({
    value: approvalFixture(state, locale),
    version: 1,
    versionId: approvalVersionId,
    locale,
    timeZone: "UTC",
    activation: { kind: state === "switching" ? "progress" : state === "activation-failed" ? "failed" : "idle" },
    nextRun: "2026-11-17T09:00:00.000Z",
    canAsk: true,
  });
}
