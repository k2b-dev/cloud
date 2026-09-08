import { z } from "zod";
import { liquidTemplateVariables, renderLiquidTemplate } from "./template-rendering";

const Text = z.string().max(320).default("");
export const AccountActionNoticeSchema = z
  .object({
    action: z.enum([
      "user.create",
      "user.update",
      "user.delete",
      "user.profile",
      "user.admin",
      "user.provider",
      "user.expiry",
      "user.password_reset",
      "user.login_token",
      "user.linux",
      "group.create",
      "group.update",
      "group.delete",
      "group.posix",
      "group.member.add",
      "group.member.remove",
      "group.manager.add",
      "group.manager.remove",
    ]),
    id: Text,
    uid: Text,
    name: Text,
    email: Text,
    firstName: Text,
    lastName: Text,
    relatedId: Text,
    provider: z.enum(["local", "ipa", ""]).default(""),
    profile: z.enum(["guest", "user", ""]).default(""),
    category: z.enum(["guest", "login", "freeipa", ""]).default(""),
  })
  .strict();
export type AccountActionNoticeInput = z.input<typeof AccountActionNoticeSchema>;
export const ACCOUNT_ACTION_NOTICE_SAMPLE = {
  action: "user.create",
  id: "",
  name: "jsmith",
  relatedId: "",
  uid: "jsmith",
  email: "jane@example.org",
  firstName: "Jane",
  lastName: "Smith",
  provider: "local",
  profile: "user",
  category: "login",
} as const;

/** Restricted, credential-free context; interpolate account fields as Markdown text. */
export const renderAccountActionNotice = (template: string, data: AccountActionNoticeInput): string | null => {
  if (!template.trim()) return null;
  const context = AccountActionNoticeSchema.parse(data);
  const unknown = liquidTemplateVariables(template).filter((name) => !Object.hasOwn(context, name));
  if (unknown.length) throw new Error(`Unknown notice variables: ${unknown.join(", ")}`);
  const markdown = renderLiquidTemplate(template, context, {
    // Liquid's built-in raw filter suppresses outputEscape. Notices always
    // interpolate account fields as text, even if an operator uses raw.
    filters: { raw: (value) => value },
    escapeOutput: (value) =>
      String(value)
        .replace(/[\\`*_{}[\]()<>!|#]/g, "\\$&")
        .replace(/[\r\n]/g, " "),
  });
  return markdown.trim() || null;
};
