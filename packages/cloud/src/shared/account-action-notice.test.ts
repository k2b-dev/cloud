import { describe, expect, test } from "bun:test";
import { SETTINGS_MAP, validateSettingValue } from "../services/settings/defaults";
import { ACCOUNT_ACTION_NOTICE_SAMPLE, AccountActionNoticeSchema, renderAccountActionNotice } from "./account-action-notice";

describe("optional account action notices", () => {
  test("empty templates and unmatched actions produce no notice", () => {
    expect(renderAccountActionNotice(" \n", { action: "user.create" })).toBeNull();
    expect(
      renderAccountActionNotice('{% if action == "group.delete" %}Check shared folders.{% endif %}', ACCOUNT_ACTION_NOTICE_SAMPLE),
    ).toBeNull();
  });
  test("one template can distinguish actions and account categories", () => {
    const template =
      '{% case action %}{% when "user.create" %}Welcome {{ uid }} ({{ category }}).{% when "group.delete" %}Review folders for {{ name }}.{% endcase %}';
    expect(renderAccountActionNotice(template, ACCOUNT_ACTION_NOTICE_SAMPLE)).toBe("Welcome jsmith (login).");
    expect(renderAccountActionNotice(template, { action: "group.delete", name: "finance", provider: "ipa" })).toBe(
      "Review folders for finance.",
    );
  });
  test("all supported actions have the same restricted context", () => {
    for (const action of AccountActionNoticeSchema.shape.action.options) {
      expect(renderAccountActionNotice("{{ action }} / {{ relatedId }}", { action, relatedId: "related-record" })).toBe(
        `${action.replaceAll("_", "\\_")} / related-record`,
      );
    }
    expect(() => AccountActionNoticeSchema.parse({ action: "user.create", password: "not-allowed" })).toThrow();
    expect(() => AccountActionNoticeSchema.parse({ action: "user.create", token: "not-allowed" })).toThrow();
    expect(() => AccountActionNoticeSchema.parse({ action: "user.create", uid: "x".repeat(321) })).toThrow();
    expect(() => AccountActionNoticeSchema.parse({ action: "unrecognized" })).toThrow();
  });
  test("interpolated values remain Markdown text, not injected markup", () => {
    expect(renderAccountActionNotice("Name: {{ name }}", { action: "group.create", name: "[link](javascript:alert(1))\n<script>" })).toBe(
      "Name: \\[link\\]\\(javascript:alert\\(1\\)\\) \\<script\\>",
    );
    expect(renderAccountActionNotice("{{ uid }}", { action: "user.create", uid: "user_name" })).toBe("user\\_name");
    expect(renderAccountActionNotice("{{ name | raw }}", { action: "group.create", name: "![image](https://example.test/image)" })).toBe(
      "\\!\\[image\\]\\(https://example.test/image\\)",
    );
  });
  test("unknown variables, external includes and oversized templates fail", () => {
    expect(() => renderAccountActionNotice("{{ password }}", ACCOUNT_ACTION_NOTICE_SAMPLE)).toThrow();
    expect(() => renderAccountActionNotice('{% include "secret" %}', ACCOUNT_ACTION_NOTICE_SAMPLE)).toThrow();
    expect(() => renderAccountActionNotice("x".repeat(200_001), ACCOUNT_ACTION_NOTICE_SAMPLE)).toThrow();
  });
  test("settings validation also catches unknown variables in inactive branches", () => {
    const def = SETTINGS_MAP.get("user.action_notice")!;
    expect(validateSettingValue(def, "").ok).toBe(true);
    expect(validateSettingValue(def, '{% if action == "group.delete" %}{{ password }}{% endif %}').ok).toBe(false);
    expect(validateSettingValue(def, '{% if provider == "ipa" %}Check {{ uid }}.{% endif %}').ok).toBe(true);
  });
});
