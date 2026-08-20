import { describe, expect, test } from "bun:test";
import { assistantHelp } from ".";

describe("assistantHelp", () => {
  test("serves the existing Assistant help topics as Markdown", async () => {
    expect(assistantHelp.documents.map((document) => document.id)).toEqual([
      "assistant-overview",
      "assistant-workflow",
      "assistant-guidance",
    ]);
    expect(assistantHelp.getMarkdown("assistant-overview")).toContain("workspace for your personal Cloud agent");
    expect(assistantHelp.getMarkdown("assistant-overview")).toContain("chats started from another application");
    expect(assistantHelp.getMarkdown("assistant-overview")).toContain("attach supported files or Cloud resources");
    expect(assistantHelp.getMarkdown("assistant-workflow")).toContain("Assistant separates Project chats from general chats");
    expect(assistantHelp.getMarkdown("assistant-workflow")).toContain("the compact context stays at the upper right");
    expect(assistantHelp.getMarkdown("assistant-workflow")).toContain("A Project chat includes its inherited Project context");
    expect(assistantHelp.getMarkdown("assistant-workflow")).toContain("Resource links open their owning app in a new tab");
    expect(assistantHelp.getMarkdown("assistant-workflow")).toContain("Always approve");
    expect(assistantHelp.getMarkdown("assistant-guidance")).toContain("Assistant works best when the request states");
    expect(assistantHelp.getMarkdown("assistant-guidance")).toContain("Assistant settings > Skills");
    expect(assistantHelp.getMarkdown("assistant-guidance")).toContain("Create a Skill that loads at the right time");
    expect(assistantHelp.getMarkdown("assistant-guidance")).toContain("Write a direct description");
  });
});
