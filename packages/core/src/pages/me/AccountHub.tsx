import { Avatar, useLocale } from "@k2b/ui";
import type { User } from "@k2b/cloud/contracts";
import { accountCategoryLabel } from "@k2b/cloud/contracts";
import type { JSXElement } from "solid-js";
import { accountMessages } from "./messages";
import ProfileActions from "./ProfileActions.island";

export type AccountSection = "overview" | "profile" | "security" | "access" | "notifications" | "developer";

export const notificationViews = (locale: string) => {
  const { t } = accountMessages.resolve([locale]);
  return [
    { id: "preferences", href: "/me/notifications", label: t.preferences, icon: "ti ti-adjustments" },
    { id: "history", href: "/me/notifications/history", label: t.deliveryHistory, icon: "ti ti-history" },
  ];
};

const roleClass = (role: string): string =>
  role === "admin"
    ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
    : "bg-violet-100 text-violet-700 dark:bg-violet-900/50 dark:text-violet-300";

export default function AccountHub(props: {
  user: User;
  active: AccountSection;
  children: JSXElement;
  actions?: JSXElement;
  loginLabel: string;
}) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const supplementalRoles = props.user.roles.filter((role) => role === "admin" || role === "group-manager");
  const expired = props.user.accountExpires ? new Date(props.user.accountExpires) < new Date() : false;
  const avatarSrc =
    props.user.id && props.user.avatarHash
      ? `/api/accounts/users/${encodeURIComponent(props.user.id)}/avatar?rev=${encodeURIComponent(props.user.avatarHash)}`
      : undefined;

  return (
    <div class="mx-auto flex w-full max-w-6xl flex-col gap-2 px-2">
      <section class="paper p-4 sm:p-5" style="view-transition-name: account-hub">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Avatar
            name={props.user.displayName || props.user.uid}
            src={avatarSrc}
            size={props.active === "overview" ? "lg" : "md"}
            class="bg-zinc-100 shadow-[var(--ui-shadow-surface)] dark:bg-zinc-800"
            style="view-transition-name: user-avatar"
          />
          <div class="min-w-0 flex-1">
            <h1 class="truncate text-xl font-semibold leading-tight text-primary">{props.user.displayName || props.user.uid}</h1>
            <p class="mt-1 truncate text-xs text-dimmed">
              {props.user.mail ?? props.user.uid}
              {props.user.displayName && props.user.profile !== "guest" ? ` · ${props.user.uid}` : ""}
            </p>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <span class="tag tag-neutral">{accountCategoryLabel(props.user, props.loginLabel)}</span>
              {supplementalRoles.map((role) => (
                <span class={`tag ${roleClass(role)}`}>{role === "group-manager" ? t().roleGroupManager : t().roleAdmin}</span>
              ))}
              {expired && <span class="tag bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300">{t().expired}</span>}
            </div>
          </div>
          {props.actions && <div class="flex shrink-0 flex-wrap items-center gap-2">{props.actions}</div>}
        </div>

        <nav class="mt-5 flex max-w-full flex-wrap gap-1" aria-label={t().accountSections}>
          {(
            [
              { id: "overview", href: "/me", label: t().overview, icon: "ti ti-layout-dashboard" },
              { id: "profile", href: "/me/profile", label: t().profile, icon: "ti ti-user" },
              { id: "security", href: "/me/security", label: t().security, icon: "ti ti-shield-lock" },
              { id: "access", href: "/me/access", label: t().access, icon: "ti ti-users-group" },
              { id: "notifications", href: "/me/notifications", label: t().notifications, icon: "ti ti-bell" },
              { id: "developer", href: "/me/developer", label: t().developer, icon: "ti ti-terminal-2" },
            ] satisfies { id: AccountSection; href: string; label: string; icon: string }[]
          ).map((section) => {
            const active = section.id === props.active;
            return (
              <a
                href={section.href}
                aria-current={active ? "page" : undefined}
                class={`flex min-h-9 shrink-0 items-center gap-2 rounded-[var(--ui-radius-control)] px-3 text-xs font-medium no-underline transition-colors ${
                  active ? "bg-[var(--ui-selected)] text-primary" : "text-secondary hover:bg-[var(--ui-surface-subtle)] hover:text-primary"
                }`}
              >
                <i class={section.icon} />
                {section.label}
              </a>
            );
          })}
        </nav>
      </section>

      <div class="min-w-0">{props.children}</div>
    </div>
  );
}

export function AccountPageHeader(props: { title: string; description: string; actions?: JSXElement; eyebrow?: string }) {
  return (
    <header class="flex flex-col gap-3 px-1 py-2 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        {props.eyebrow && <p class="section-label mb-1">{props.eyebrow}</p>}
        <h2 class="text-xl font-semibold text-primary">{props.title}</h2>
        <p class="mt-1 max-w-2xl text-sm text-dimmed">{props.description}</p>
      </div>
      {props.actions && <div class="flex shrink-0 flex-wrap items-center gap-2">{props.actions}</div>}
    </header>
  );
}

export function AccountProfileActions(props: {
  user: User;
  appName: string;
  freeIpaEnabled: boolean;
  actions?: ("avatar" | "profile" | "details" | "extend")[];
}) {
  return (
    <ProfileActions
      userId={props.user.id}
      provider={props.user.provider}
      profile={props.user.profile}
      uid={props.user.uid}
      givenname={props.user.givenname}
      sn={props.user.sn}
      displayName={props.user.displayName}
      avatarHash={props.user.avatarHash}
      ipa={props.user.ipa}
      appName={props.appName}
      freeIpaEnabled={props.freeIpaEnabled}
      actions={props.actions}
    />
  );
}

export function AccountSubnav(props: { active: string; items: { id: string; href: string; label: string; icon: string }[] }) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  return (
    <nav
      class="flex max-w-full flex-wrap gap-1 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-1"
      aria-label={t().sectionViews}
    >
      {props.items.map((item) => {
        const active = item.id === props.active;
        return (
          <a
            href={item.href}
            aria-current={active ? "page" : undefined}
            class={`flex min-h-9 shrink-0 items-center gap-2 rounded-[var(--ui-radius-control)] px-3 text-xs font-medium no-underline transition-colors ${
              active ? "bg-[var(--ui-surface)] text-primary shadow-[var(--ui-shadow-surface)]" : "text-secondary hover:text-primary"
            }`}
          >
            <i class={item.icon} />
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
