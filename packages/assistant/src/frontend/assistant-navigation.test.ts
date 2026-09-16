import { describe, expect, test } from "bun:test";
import {
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
