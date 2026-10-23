import { describe, expect, test } from "bun:test";
import {
  ASSISTANT_APPROVALS_HREF,
  assistantApprovalsOpenFromHref,
  assistantArtifactHref,
  assistantArtifactPathFromHref,
  assistantConversationHref,
  assistantConversationIdFromHref,
  assistantProjectHref,
  assistantProjectIdFromHref,
  shouldCommitConversationNavigation,
  shouldOpenProjectConversation,
} from "./assistant-navigation";

describe("Assistant conversation navigation", () => {
  test("sets and encodes the conversation while preserving other URL state", () => {
    expect(assistantConversationHref("https://cloud.test/app/assistant?mode=compact#latest", "chat / one")).toBe(
      "/app/assistant?mode=compact&conversation=chat+%2F+one#latest",
    );
  });

  test("removes only the conversation parameter", () => {
    expect(assistantConversationHref("/app/assistant?conversation=old&mode=compact#latest", null)).toBe(
      "/app/assistant?mode=compact#latest",
    );
  });

  test("leaves the approvals view for a chat or a Project", () => {
    expect(assistantApprovalsOpenFromHref(ASSISTANT_APPROVALS_HREF)).toBe(true);
    expect(assistantApprovalsOpenFromHref("/app/assistant?approvals=0")).toBe(false);
    expect(assistantConversationHref(ASSISTANT_APPROVALS_HREF, "chat-1")).toBe("/app/assistant?conversation=chat-1");
    expect(assistantProjectHref(ASSISTANT_APPROVALS_HREF, "prj123")).toBe("/app/assistant?project=prj123");
  });

  test("reads conversation ids from absolute and relative hrefs", () => {
    expect(assistantConversationIdFromHref("/app/assistant?conversation=chat-1")).toBe("chat-1");
    expect(assistantConversationIdFromHref("https://cloud.test/app/assistant?conversation=chat%202")).toBe("chat 2");
    expect(assistantConversationIdFromHref("/app/assistant")).toBeNull();
  });

  test("switches to an SSR-addressable Project without stale chat state", () => {
    expect(assistantProjectHref("/app/assistant?conversation=chat-1&artifact=%2Freport.md&q=launch", "prj123")).toBe(
      "/app/assistant?project=prj123",
    );
    expect(assistantConversationHref("/app/assistant?project=prj123&q=launch", "chat-2")).toBe("/app/assistant?conversation=chat-2");
  });

  test("reads Project navigation state from absolute and relative hrefs", () => {
    expect(assistantProjectIdFromHref("/app/assistant?project=prj123&q=launch+plan")).toBe("prj123");
    expect(assistantProjectIdFromHref("/app/assistant")).toBeNull();
  });

  test("keeps an artifact within one conversation and clears it when switching chats", () => {
    const withArtifact = assistantArtifactHref("/app/assistant?conversation=chat-1", "/files/report.md");
    expect(withArtifact).toBe("/app/assistant?conversation=chat-1&artifact=%2Ffiles%2Freport.md");
    expect(assistantArtifactPathFromHref(withArtifact)).toBe("/files/report.md");
    expect(assistantConversationHref(withArtifact, "chat-2")).toBe("/app/assistant?conversation=chat-2");
    expect(assistantArtifactHref(withArtifact, null)).toBe("/app/assistant?conversation=chat-1");
  });

  test("commits successful opens and in-flight same-target clicks without duplicating the current URL", () => {
    const current = "/app/assistant?conversation=chat-1";
    const target = "/app/assistant?conversation=chat-2";
    expect(shouldCommitConversationNavigation("opened", current, target)).toBe(true);
    expect(shouldCommitConversationNavigation("unchanged", current, target)).toBe(true);
    expect(shouldCommitConversationNavigation("unchanged", current, current)).toBe(false);
    expect(shouldCommitConversationNavigation("stale", current, target)).toBe(false);
  });

  test("reopens the underlying active chat when the visible view is a Project", () => {
    expect(shouldOpenProjectConversation("project-1", "chat-1", "chat-1")).toBe(true);
    expect(shouldOpenProjectConversation(null, "chat-1", "chat-1")).toBe(false);
    expect(shouldOpenProjectConversation(null, "chat-1", "chat-2")).toBe(true);
  });
});

test("message deep links accept positive sequences and do not leak into another chat or project", async () => {
  const { assistantMessageSeqFromHref } = await import("./assistant-navigation");
  expect(assistantMessageSeqFromHref("/app/assistant?conversation=Chat01&message=17")).toBe(17);
  for (const value of ["0", "-1", "1.2", "1e3", "9007199254740992", "text"]) {
    expect(assistantMessageSeqFromHref(`/app/assistant?message=${value}`)).toBeNull();
  }
  const current = "/app/assistant?conversation=Chat01&message=17";
  expect(assistantConversationHref(current, "Chat01")).toBe(current);
  expect(assistantConversationHref(current, "Chat02")).toBe("/app/assistant?conversation=Chat02");
  expect(assistantProjectHref(current, "Proj01")).toBe("/app/assistant?project=Proj01");
});

test("question locations replace a message, survive in their chat and do not leak into another chat or project", async () => {
  const { assistantMessageHref, assistantQuestionAnchorFromHref, assistantQuestionHref } = await import("./assistant-navigation");
  const atMessage = "/app/assistant?conversation=Chat01&message=17&artifact=report.md";
  const atQuestion = assistantQuestionHref(atMessage, "Chat01", "tool-call-1");
  expect(atQuestion).toBe("/app/assistant?conversation=Chat01&artifact=report.md&question=tool-call-1");
  expect(assistantQuestionHref(atMessage, "Chat02", "tool-call-2")).toBe("/app/assistant?conversation=Chat02&question=tool-call-2");
  expect(assistantQuestionAnchorFromHref(atQuestion)).toBe("tool-call-1");
  for (const value of ["", "call-1", `tool-${"x".repeat(260)}`])
    expect(assistantQuestionAnchorFromHref(`/app/assistant?question=${value}`)).toBeNull();
  expect(assistantMessageHref(atQuestion, 3)).toBe("/app/assistant?conversation=Chat01&artifact=report.md&message=3");
  expect(assistantConversationHref(atQuestion, "Chat02")).toBe("/app/assistant?conversation=Chat02");
  expect(assistantProjectHref(atQuestion, "Proj01")).toBe("/app/assistant?project=Proj01");
});

test("conversation and project changes preserve the provider subtree without carrying an old message", () => {
  const current = "/app/assistant/panel?conversation=old&message=2&artifact=report.md";
  expect(assistantConversationHref(current, "next")).toBe("/app/assistant/panel?conversation=next");
  expect(assistantProjectHref(current, "project1")).toBe("/app/assistant/panel?project=project1");
});
