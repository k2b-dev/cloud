import { describe, expect, test } from "bun:test";
import { assistantHelp } from ".";

describe("assistantHelp", () => {
  test("serves the existing Assistant help topics as English Markdown", () => {
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

  test("translates every article to German with matching metadata", () => {
    const english = assistantHelp.documentsByLocale?.en ?? [];
    const german = assistantHelp.documentsByLocale?.de ?? [];

    expect(german.map((document) => document.id)).toEqual(english.map((document) => document.id));
    for (const document of german) {
      const base = english.find((candidate) => candidate.id === document.id);
      expect(base).toBeDefined();
      expect(document.icon).toBe(base!.icon!);
      expect(document.order).toBe(base!.order);
    }

    expect(assistantHelp.getMarkdown("assistant-overview", "de")).toContain(
      "Der Assistent ist der zentrale Arbeitsbereich für deinen persönlichen Cloud-Agenten",
    );
    expect(assistantHelp.getMarkdown("assistant-workflow", "de")).toContain(
      "Der Assistent trennt Projekt-Chats und allgemeine Chats",
    );
    expect(assistantHelp.getMarkdown("assistant-guidance", "de")).toContain(
      "Eine hilfreiche Anfrage formulieren",
    );
  });

  test("resolves regional and unknown locales through the fallback chain", () => {
    expect(assistantHelp.getMarkdown("assistant-overview", "de-CH")).toBe(
      assistantHelp.getMarkdown("assistant-overview", "de")!,
    );
    expect(assistantHelp.getMarkdown("assistant-overview", "de-CH")).toContain(
      "Der Assistent ist der zentrale Arbeitsbereich für deinen persönlichen Cloud-Agenten",
    );
    expect(assistantHelp.getMarkdown("assistant-overview", "fr")).toBe(
      assistantHelp.getMarkdown("assistant-overview")!,
    );
    expect(assistantHelp.getMarkdown("assistant-overview", "fr")).toContain(
      "workspace for your personal Cloud agent",
    );
  });
});
