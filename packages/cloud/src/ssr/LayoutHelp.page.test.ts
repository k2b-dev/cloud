import { describe, expect, test } from "bun:test";
import { helpLinkTarget, helpPageAppId, layoutHelpTopicHref } from "./layout-help-url";

describe("layoutHelpTopicHref", () => {
  test("opens an app-owned Help topic", () => {
    expect(layoutHelpTopicHref("/app/assistant/help", "assistant-workflow")).toBe("/app/assistant/help/assistant-workflow");
  });

  test("returns the Help hub for a missing topic", () => {
    expect(layoutHelpTopicHref("/app/notebooks/help", null)).toBe("/app/notebooks/help");
  });

  test("normalizes a trailing slash and encodes the topic segment", () => {
    expect(layoutHelpTopicHref("/app/contacts/help/", "contacts/reach")).toBe("/app/contacts/help/contacts%2Freach");
  });
});

describe("Core Help ownership", () => {
  test("matches only the exact overview or one topic, decoding the app", () => {
    for (const path of ["/help/apps/spaces", "/help/apps/spaces/", "/help/apps/spaces/start", "/help/apps/spaces/start/"])
      expect(helpPageAppId(path)).toBe("spaces");
    expect(helpPageAppId("/help/apps/time%20track/start")).toBe("time track");
    for (const path of ["/help", "/help/apps", "/help/apps/x/y/z", "/helpx/apps/x", "/app/x/help", "/help/apps/%zz", "/help/apps/x//"])
      expect(helpPageAppId(path)).toBeNull();
  });
});

describe("in-place Help links", () => {
  const current = "https://cloud.test/help/apps/spaces/start";
  const help = { appId: "spaces", pageBase: "/app/spaces/help/" };
  test("sections and both app-owned and central topic routes", () => {
    expect(helpLinkTarget("#next%20step", current, help)).toEqual({ kind: "section", hash: "next step" });
    for (const base of ["/app/spaces/help", "/help/apps/spaces"]) {
      expect(helpLinkTarget(base + "/", current, help)).toEqual({ kind: "topic", topicId: null, hash: "" });
      expect(helpLinkTarget(base + "/second%2Fpart#steps", current, help)).toEqual({
        kind: "topic",
        topicId: "second/part",
        hash: "steps",
      });
      expect(helpLinkTarget("https://cloud.test" + base + "/next/", current, help)).toEqual({ kind: "topic", topicId: "next", hash: "" });
    }
  });
  test("leaves other addresses and malformed fragments to native navigation", () => {
    for (const href of [
      "#",
      "#%zz",
      "/app/spaces/help/%zz",
      "/app/spaces/help/start?q=x",
      "/help/apps/spaces/one/two",
      "/help/apps/mail/start",
      "/app/spaces",
      "https://outside.test/app/spaces/help/start",
    ])
      expect(helpLinkTarget(href, current, help)).toBeNull();
    expect(helpLinkTarget("/help/apps/time%20track/topic", current, { appId: "time track" })).toEqual({
      kind: "topic",
      topicId: "topic",
      hash: "",
    });
  });
});
