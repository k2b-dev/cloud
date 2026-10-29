import { AdminArea } from "@k2b/cloud/ssr";
import type { JSX } from "solid-js";
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
  signin: "ti ti-login",
  registration: "ti ti-user-plus",
  security: "ti ti-shield-lock",
  linux: "ti ti-terminal-2",
  freeipa: "ti ti-building-fortress",
  operations: "ti ti-tool",
};

export const signinText = (locale: string): SigninAreaMessages => signinAreaMessages.resolve([locale]).t;

/** The Sign-in & security area: its sections as the first column and the open section beside it. */
export function SigninArea(props: {
  c: Parameters<typeof AdminArea>[0]["c"];
  locale: string;
  section: SigninSection;
  children: JSX.Element;
}) {
  const t = signinText(props.locale);
  const item = (section: SigninSection) => ({ id: section, label: t[section], href: SIGNIN_SECTION_HREF[section], icon: ICON[section] });
  return (
    <AdminArea
      c={props.c}
      label={t.area}
      sectionsLabel={t.sections}
      href={SIGNIN_SECTION_HREF.signin}
      groups={[
        { items: [item("signin"), item("registration"), item("security")] },
        { title: t.groupDirectory, items: [item("linux"), item("freeipa"), item("operations")] },
      ]}
      current={props.section}
      title={t[props.section]}
    >
      {props.children}
    </AdminArea>
  );
}
