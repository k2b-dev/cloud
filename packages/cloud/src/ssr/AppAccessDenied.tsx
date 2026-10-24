import { AppWorkspace, ButtonLink, useLocale } from "@k2b/ui";
import { For, type JSX, Show } from "solid-js";
import { appAccessMessages } from "../access/app-access-messages";
import PrincipalAvatar from "../access/PrincipalAvatar";
import { principalLabel } from "../access/principal-label";
import type { AppMeta } from "../contracts/app";
import type { AccessEntry } from "../contracts/shared";
import { appAccentStyle } from "./app-appearance";
import Layout from "./Layout";
import type { LayoutContext } from "./layout-context";

export function AppAccessDeniedContent(props: {
  app: Pick<AppMeta, "id" | "name" | "icon" | "access" | "appearance">;
  managers: AccessEntry[];
  canRepair?: boolean;
  revoked?: boolean;
}) {
  const locale = useLocale(),
    t = () => appAccessMessages.resolve([locale()]).t;
  const grants = () => props.app.access?.kind === "grants";
  // A fixed rule names itself before the contact, so the reader knows why and whom to ask.
  const rule = () => {
    const access = props.app.access;
    if (access?.kind === "noGuests") return t().deniedNoGuests({ name: props.app.name });
    if (access?.kind !== "roles") return undefined;
    return access.roles.length === 1 && access.roles[0] === "admin"
      ? t().deniedAdmins({ name: props.app.name })
      : t().deniedRoles({ name: props.app.name });
  };
  return (
    <div class="mx-auto mt-8 w-full max-w-[460px] text-left sm:mt-[10vh]">
      <span
        class="app-accent-scope app-accent-text k2b-icon-tile mb-4 flex h-12 w-12 items-center justify-center rounded-xl text-[26px]"
        style={appAccentStyle(props.app.appearance?.accent)}
        aria-hidden="true"
      >
        <i class={props.app.icon} />
      </span>
      <h1 class="mb-2 text-[22px] font-semibold">{(props.revoked ? t().revokedTitle : t().deniedTitle)({ name: props.app.name })}</h1>
      <p class="mb-4 text-[15px] text-secondary">
        {props.revoked ? (
          t().revokedDescription
        ) : grants() ? (
          t().deniedGrants
        ) : (
          <>
            <Show when={rule()}>{(sentence) => <>{sentence()} </>}</Show>
            {t().deniedFixed}
          </>
        )}
      </p>
      {/* A fixed rule's contact is the Cloud administration the sentence already names. */}
      <Show when={props.revoked || grants()}>
        <div class="mb-5 flex flex-col gap-2">
          <For each={props.managers}>
            {(entry) => (
              <div class="flex items-center gap-2.5">
                <PrincipalAvatar entry={entry} label={principalLabel(entry, locale())} />
                <span>{principalLabel(entry, locale())}</span>
              </div>
            )}
          </For>
          <Show when={!props.managers.length}>
            <p class="text-sm">{t().askAdministration}</p>
          </Show>
        </div>
      </Show>
      <ButtonLink href="/" variant="ghost" style={{ "min-height": "36px", "font-size": "15px" }}>
        {t().home}
      </ButtonLink>
      <Show when={props.canRepair && grants()}>
        <p class="mt-5 text-[13px] text-dimmed">
          {t().adminHintBefore}
          {/* An inline link in the action colour and weight, as the approved denial page shows it. */}
          <a
            class="focus-ui whitespace-nowrap rounded-sm font-medium text-[var(--k2b-action)] hover:underline"
            href={`/admin/apps?app=${encodeURIComponent(props.app.id)}`}
          >
            {t().adminHintLink}
          </a>
          {t().adminHintAfter}
        </p>
      </Show>
    </div>
  );
}

/** The white work surface every application page has; the denial page sits on it like the app it replaces. */
export function AppAccessDeniedFrame(props: { children: JSX.Element }) {
  return (
    <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1" resizable={false}>
      <AppWorkspace.Content>
        <AppWorkspace.Main class="p-4 sm:p-6">{props.children}</AppWorkspace.Main>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}

export const renderAppAccessDenied =
  (c: LayoutContext, app: Pick<AppMeta, "id" | "name" | "icon" | "access" | "appearance">, managers: AccessEntry[], canRepair: boolean) =>
  () => (
    <Layout c={c} title={[{ title: app.name }]} fullWidth fullPage>
      <AppAccessDeniedFrame>
        <AppAccessDeniedContent
          app={app}
          managers={managers}
          canRepair={canRepair}
          revoked={new URL(c.req.raw.url).searchParams.get("_cloud_access") === "revoked"}
        />
      </AppAccessDeniedFrame>
    </Layout>
  );
