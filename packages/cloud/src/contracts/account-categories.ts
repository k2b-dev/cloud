import { z } from "zod";

/** Presentation categories are derived, never stored on an account. */
export type AccountCategory = "guest" | "login" | "freeipa";
const categoryPolicy = z.object({ enabled: z.boolean(), visible: z.boolean() }).strict();
export const AccountCategoryPolicySchema = z
  .object({
    guest: categoryPolicy,
    login: categoryPolicy
      .extend({
        label: z
          .string()
          .trim()
          .transform((label) => label || "Login"),
      })
      .strict(),
    freeipa: categoryPolicy,
  })
  .strict();
export type AccountCategoryPolicy = z.infer<typeof AccountCategoryPolicySchema>;

export const DEFAULT_ACCOUNT_CATEGORY_POLICY: AccountCategoryPolicy = {
  guest: { enabled: true, visible: true },
  login: { enabled: true, visible: true, label: "Login" },
  freeipa: { enabled: true, visible: true },
};

export const accountCategory = (user: { provider: "local" | "ipa"; profile: "guest" | "user" }): AccountCategory =>
  user.provider === "ipa" ? "freeipa" : user.profile === "guest" ? "guest" : "login";

export const accountCategoryLabel = (user: { provider: "local" | "ipa"; profile: "guest" | "user" }, loginLabel = "Login"): string => {
  const category = accountCategory(user);
  return category === "freeipa" ? "FreeIPA" : category === "guest" ? "Guest" : loginLabel.trim() || "Login";
};

export const visibleAccountCategories = (policy: AccountCategoryPolicy, freeIpaEnabled: boolean): AccountCategory[] =>
  (["guest", "login", "freeipa"] as const).filter(
    (category) => policy[category].enabled && policy[category].visible && (category !== "freeipa" || freeIpaEnabled),
  );

/** Explicit links can open hidden, allowed categories; cookies cannot. Legacy
 * email links remain unbound to Guest so existing full-account links work. */
export const resolveAccountCategoryLogin = (input: {
  policy: AccountCategoryPolicy;
  freeIpaEnabled: boolean;
  method?: string;
  remembered?: string | null;
  hasToken?: boolean;
  hideGuest?: boolean;
}): { visible: AccountCategory[]; active: AccountCategory | "email" | null } => {
  const visible = visibleAccountCategories(input.policy, input.freeIpaEnabled).filter(
    (category) => !input.hideGuest || category === "freeipa",
  );
  if (input.hasToken) return { visible, active: "email" };
  if (input.method === "email") return { visible, active: input.policy.guest.enabled || input.policy.login.enabled ? "email" : null };
  const method = input.method === "ipa" ? "freeipa" : input.method;
  if (method === "guest" || method === "login" || method === "freeipa") {
    return { visible, active: input.policy[method].enabled && (method !== "freeipa" || input.freeIpaEnabled) ? method : null };
  }
  const remembered = input.remembered === "ipa" ? "freeipa" : input.remembered;
  return { visible, active: visible.find((category) => category === remembered) ?? visible[0] ?? null };
};
