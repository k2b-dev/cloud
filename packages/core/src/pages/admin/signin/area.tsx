import { adminNavigation } from "@k2b/cloud/ssr";
import { type SigninAreaMessages, signinAreaMessages } from "./messages";

export const SIGNIN_SECTIONS = ["signin", "registration", "security", "linux", "freeipa", "operations"] as const;
export type SigninSection = (typeof SIGNIN_SECTIONS)[number];

export const SIGNIN_SECTION_HREF: Record<SigninSection, string> = {
  signin: "/admin/signin",
  registration: "/admin/signin/registration",
  security: "/admin/signin/security",
  linux: "/admin/signin/linux",
  freeipa: "/admin/signin/freeipa",
  operations: "/admin/signin/operations",
};

const ICON: Record<SigninSection, string> = {
  signin: "login",
  registration: "user-plus",
  security: "shield-lock",
  linux: "terminal-2",
  freeipa: "building-fortress",
  operations: "tool",
};

export const signinText = (locale: string): SigninAreaMessages => signinAreaMessages.resolve([locale]).t;

/** The admin bar with the Sign-in & security sections one level in under its entry, the open one current. */
export const signinNav = (c: Parameters<typeof adminNavigation>[0], locale: string, current: SigninSection) => {
  const t = signinText(locale);
  return adminNavigation(
    c,
    SIGNIN_SECTIONS.map((section) => ({
      label: t[section],
      icon: ICON[section],
      href: SIGNIN_SECTION_HREF[section],
      current: section === current,
    })),
  );
};
