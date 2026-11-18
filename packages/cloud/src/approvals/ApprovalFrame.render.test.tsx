import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { ApprovalFrameProps } from "./ApprovalFrame";

registerSsrTestPlugin({ dev: true, rootDir: mkdtempSync(join(tmpdir(), "approval-frame-render-")) });
const { ApprovalFrame } = await import("./ApprovalFrame");

for (const locale of ["de", "en"])
  for (const state of ["open", "sending", "decided", "expired", "loading"] as const) {
    test(`${locale}: ${state} server-renders the shared compact approval, with deferred details`, () => {
      let detailsRead = false;
      const props: ApprovalFrameProps = {
        locale,
        state,
        source: { name: "Code", icon: "ti ti-code" },
        sentence: "Version 5 ist bereit zum Einschalten.",
        reason: { text: "Code · liest Mails · täglich um 8:00" },
        details: {
          label: "Details von Code",
          content: () => {
            detailsRead = true;
            return "The complete proposal";
          },
        },
        confirm: { label: "Einschalten", onSelect: () => {} },
      };
      const html = renderToString(() => createComponent(ApprovalFrame, props));
      expect(detailsRead).toBe(false);
      expect(html).toContain('data-row=""');
      expect(html).toContain('data-tone="ai"');
      expect(html).toContain('data-reserve=""');
      expect(html.match(/ti-shield-check/g)).toHaveLength(1);
      expect(html.match(/class="k2b-notice-card__action-slot"/g)).toHaveLength(2);
      expect(html.match(/Version 5 ist bereit zum Einschalten\./g)).toHaveLength(1);
      expect(html).toContain(locale === "de" ? "Alles ansehen" : "See everything");
      expect(html).not.toContain("The complete proposal");
      expect(html).not.toContain("k2b-chat-decision");
    });
  }

test("an actionless final receipt is compact, but loading always reserves its phone height", () => {
  for (const state of ["decided", "loading"] as const) {
    const html = renderToString(() =>
      createComponent(ApprovalFrame, {
        locale: "de",
        state,
        source: { name: "Code", icon: "ti ti-code" },
        reason: { text: "" },
        reserve: false,
      }),
    );
    expect(html.includes('data-reserve=""')).toBe(state === "loading");
  }
});

test("additional facts alone stay reachable through the complete detail view", () => {
  const html = renderToString(() =>
    createComponent(ApprovalFrame, {
      locale: "de",
      state: "open",
      source: { name: "Mail", icon: "ti ti-mail" },
      sentence: "Nachricht senden?",
      reason: { text: "Mail fragt nach" },
      meta: [{ text: "Nur einmal", icon: "ti ti-lock" }],
    }),
  );
  expect(html).toContain("Alles ansehen");
  expect(html).not.toContain("Nur einmal");
});
