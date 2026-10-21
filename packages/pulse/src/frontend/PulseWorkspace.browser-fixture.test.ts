import { describe, expect, test } from "bun:test";
import { workspaceDocumentContent } from "./PulseWorkspace.browser-fixture";

describe("Pulse SSR document fixture", () => {
  test("removes scripts structurally, including mixed-case tags and markup inside script text", () => {
    const content = workspaceDocumentContent(
      "<!DOCTYPE html><HTML><HEAD><title>Fixture</title><SCRIPT>head()</SCRIPT></HEAD><BODY>" +
        '<main data-note="body > shell"><script>const tag = "<script>";</script>' +
        '<ScRiPt data-note=">">mixed()</sCrIpT><template><SCRIPT>nested()</SCRIPT></template>' +
        '<p>&lt;script&gt; stays readable</p><solid-island data-file="PulseWorkspace.island.tsx" data-props="fixture">' +
        "<section>Actual workspace</section></solid-island></main></BODY><SCRIPT>loader()</SCRIPT></HTML>",
    );
    expect(content).toBe(
      '<main data-note="body > shell"><template></template><p>&lt;script&gt; stays readable</p>' +
        '<solid-island data-file="PulseWorkspace.island.tsx" data-props="fixture" id="root">' +
        "<section>Actual workspace</section></solid-island></main>",
    );
  });

  test("keeps the body and other islands intact and sets only the workspace mount target", () => {
    const content = workspaceDocumentContent(
      '<html><head></head><body><solid-island data-file="ShellRuntime.island.tsx" id="shell"></solid-island>' +
        '<solid-island id="previous" data-file="PulseWorkspace.island.tsx"><p>First SSR frame</p></solid-island></body></html>',
    );
    expect(content).toBe(
      '<solid-island data-file="ShellRuntime.island.tsx" id="shell"></solid-island>' +
        '<solid-island id="root" data-file="PulseWorkspace.island.tsx"><p>First SSR frame</p></solid-island>',
    );
  });
});
