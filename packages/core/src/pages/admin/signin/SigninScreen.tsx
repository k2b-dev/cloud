import { coreClient } from "@k2b/cloud/clients/core";
import type { GeoIpAdminStatus } from "@k2b/cloud/contracts";
import { settingsSaveControls } from "@k2b/cloud/ssr/settings-draft";
import { useLocale } from "@k2b/ui";
import { Button, type NavProps, Notice, Popover, useToast } from "@k2b/ui/v2";
import { createSignal, type JSX, Show } from "solid-js";
import type { ApprovalAvailability } from "../../app-approval/availability";
import { appApprovalMessages } from "../../app-approval/messages";
import AreaFrame from "../_area/AreaFrame";
import RegistryForm, { type RegistryFormSection } from "../_area/RegistryForm";
import { adminToasts } from "../_area/toasts";
import { settingsMessages } from "../settings/_components/messages";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import AccountOperations from "./AccountOperations";
import { LinuxContent, type LinuxOverview, LinuxStatus, useLinuxIdentities } from "./LinuxIdentities";
import type { LinuxState } from "./linux-query";
import { signinAreaMessages } from "./messages";
import SignInLocations from "./SignInLocations";

export type SigninSectionId = "signin" | "registration" | "security" | "linux" | "freeipa" | "operations";

type Frame = { nav: NavProps; documentationHref?: string };

/**
 * Tests the saved FreeIPA connection; while the form has unsaved changes, it waits for Save. A reachable FreeIPA is a
 * toast; a failure names FreeIPA's reason through `onFailure`, which the section shows above the form.
 */
const TestFreeIpa = (props: { onFailure: (reason: string | null) => void }) => {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const n = () => adminToasts.resolve([locale()]).t;
  const toast = useToast();
  const [busy, setBusy] = createSignal(false);
  const pending = () => (settingsSaveControls()?.state ?? "saved") !== "saved";
  const run = async () => {
    setBusy(true);
    props.onFailure(null);
    try {
      const response = await coreClient.admin.core.settings["test-freeipa"].$post();
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) throw new Error(body?.message ?? t().freeIpaTestFailed({ status: response.status }));
      toast(n().freeIpaReachable, { status: "ok" });
    } catch (error) {
      props.onFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover tip={pending() ? t().testFreeIpaPending : t().testFreeIpaSaved}>
      <Button icon="plug-connected" busy={busy()} disabled={pending()} onClick={() => void run()}>
        {t().testConnection}
      </Button>
    </Popover>
  );
};

/** Whether people can sign in to apps through Cloud now, from the server's read of the app sign-in settings. */
const ApprovalState = (props: { state: ApprovalAvailability }) => {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  const detail = () =>
    props.state === "disabled"
      ? t().disabled
      : props.state === "configured"
        ? t().configuredHint
        : props.state === "setup-required"
          ? t().setupAdmin
          : t().unavailableAdmin;
  const title = () =>
    ({
      disabled: t().statusDisabled,
      "setup-required": t().statusSetup,
      configured: t().statusConfigured,
      unavailable: t().statusUnavailable,
    })[props.state];
  return (
    <Notice tone={props.state === "setup-required" || props.state === "unavailable" ? "warn" : "note"} icon="apps" title={title()}>
      {detail()}
    </Notice>
  );
};

/** The frame of every section of the Sign-in & security area. */
function SigninFrame(props: Frame & { section: SigninSectionId; actions?: JSX.Element; status?: JSX.Element; children: JSX.Element }) {
  const locale = useLocale();
  const t = () => signinAreaMessages.resolve([locale()]).t;
  return (
    <AreaFrame
      nav={props.nav}
      area={{ label: t().area, href: "/admin/signin" }}
      title={t()[props.section]}
      description={t()[`${props.section}Description`]}
      documentationHref={props.documentationHref}
      actions={props.actions}
      status={props.status}
    >
      {props.children}
    </AreaFrame>
  );
}

export type SigninFormScreenProps = Frame & {
  section: "signin" | "registration" | "security" | "freeipa";
  groups: string[];
  sections: RegistryFormSection[];
  entries: SettingFieldDef[];
  /** Sign-in only: the app sign-in state and where sign-ins come from. */
  approvalState?: ApprovalAvailability;
  signInLocations?: { status: GeoIpAdminStatus | null; actorId: string };
};

/** A registry section of the Sign-in & security area; Sign-in adds the app sign-in state and the sign-in locations. */
export function SigninFormScreen(props: SigninFormScreenProps) {
  const locale = useLocale();
  const s = () => settingsMessages.resolve([locale()]).t;
  const n = () => adminToasts.resolve([locale()]).t;
  const [failure, setFailure] = createSignal<string | null>(null);
  return (
    <SigninFrame
      nav={props.nav}
      section={props.section}
      documentationHref={props.documentationHref}
      actions={props.section === "freeipa" ? <TestFreeIpa onFailure={setFailure} /> : undefined}
    >
      <Show when={failure()}>
        {(reason) => (
          <Notice tone="bad" title={n().testFailed}>
            {reason()}
          </Notice>
        )}
      </Show>
      <Show when={props.section === "freeipa"}>
        <Notice tone="note" title={s().testsUseSaved}>
          {s().testsUseSavedDescription}
        </Notice>
      </Show>
      <RegistryForm
        groups={props.groups}
        sections={props.sections}
        entries={props.entries}
        // The app sign-in state below the form comes from the server and follows a saved change.
        reloadAfter={
          props.approvalState ? ["user.app_approval.enabled", "user.app_approval.origin", "user.app_approval.admin_pairing"] : undefined
        }
      />
      <Show when={props.approvalState}>{(state) => <ApprovalState state={state()} />}</Show>
      <Show when={props.signInLocations}>
        {(locations) => <SignInLocations initial={locations().status} actorId={locations().actorId} />}
      </Show>
    </SigninFrame>
  );
}

export type LinuxScreenProps = Frame & { linux: { initial: LinuxOverview; state: LinuxState; after: string | null } };

/** Local Linux identities: the setup and the accounts, with the list's filters under the head. */
export function LinuxScreen(props: LinuxScreenProps) {
  const linux = useLinuxIdentities(props.linux);
  return (
    <SigninFrame
      nav={props.nav}
      section="linux"
      documentationHref={props.documentationHref}
      actions={
        <Button icon="refresh" disabled={linux.busy()} onClick={linux.refresh}>
          {linux.t().refresh}
        </Button>
      }
      status={<LinuxStatus linux={linux} />}
    >
      <LinuxContent linux={linux} />
    </SigninFrame>
  );
}

export type OperationsScreenProps = Frame & { freeIpaEnabled: boolean };

/** Account operations: the logs of account work and the backfills. */
export function OperationsScreen(props: OperationsScreenProps) {
  return (
    <SigninFrame nav={props.nav} section="operations" documentationHref={props.documentationHref}>
      <AccountOperations freeIpaEnabled={props.freeIpaEnabled} />
    </SigninFrame>
  );
}
