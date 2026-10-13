import { expect, test } from "bun:test";
import { type CloudCliContext, cloudResourceUrl } from "./index";

test.each(["https://cloud.example", "https://cloud.example/", "https://cloud.example/ignored/path"])(
  "makes a resource permalink absolute on %s",
  (server) => {
    const ctx: Pick<CloudCliContext, "options"> = {
      options: { server, profile: "test", token: "", output: "text" },
    };
    expect(cloudResourceUrl(ctx, { type: "mail.draft", id: "a/b?c# Grüße" })).toBe(
      "https://cloud.example/open/mail.draft/a%2Fb%3Fc%23%20Gr%C3%BC%C3%9Fe",
    );
  },
);
