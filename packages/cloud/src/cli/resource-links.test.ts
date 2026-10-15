import { expect, test } from "bun:test";
import { type CloudCliContext, cloudResourceUrl, withCloudResourcePermalink } from "./index";

test.each(["https://cloud.example", "https://cloud.example/", "https://cloud.example/ignored/path"])(
  "makes a resource permalink absolute on %s",
  (server) => {
    const ctx: Pick<CloudCliContext, "options"> = {
      options: { server, profile: "test", token: "", output: "text" },
    };
    expect(cloudResourceUrl(ctx, { type: "mail.draft", id: "a/b?c# Grüße" })).toBe(
      "https://cloud.example/open/mail.draft/~a%2Fb%3Fc%23%20Gr%C3%BC%C3%9Fe",
    );
  },
);

test("adds a permalink without changing domain data", () => {
  const ctx = { options: { profile: "test", token: "", server: "https://cloud.example/", output: "json" as const } };
  const resource = { id: "AbC123", url: "https://event.example/join", title: "Event" };
  expect(withCloudResourcePermalink(ctx, "spaces.item", resource)).toEqual({
    ...resource,
    permalink: "https://cloud.example/open/spaces.item/~AbC123",
  });
  expect(resource).not.toHaveProperty("permalink");
});
