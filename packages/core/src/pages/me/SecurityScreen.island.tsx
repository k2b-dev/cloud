import type {
  AppDevicesPageSchema,
  PwaDeviceView,
  ServiceAccountCredential,
  UserProfile,
  UserProvider,
  WebAuthnPasskey,
} from "@k2b/cloud/contracts";
import type { DateContext } from "@k2b/stdlib";
import { Pane } from "@k2b/ui/v2";
import { Show } from "solid-js";
import type { z } from "zod";
import type { ApprovalAvailability } from "../app-approval/availability";
import DevicesSection from "../app-approval/DevicesSection";
import AccountWorkspace, { AccountTabs, sideWidth } from "./AccountWorkspace";
import { useApiKeys } from "./ApiKeysSection";
import { useAppDevices } from "./AppDevicesSection";
import type { AccountUserView } from "./account-view";
import PasskeysSection from "./PasskeysSection";
import SignInSection from "./SignInSection";

export type SecurityScreenProps = {
  user: AccountUserView;
  userId: string;
  provider: UserProvider;
  profile: UserProfile;
  freeIpaEnabled: boolean;
  passkeys: WebAuthnPasskey[];
  /** The sign-in app's devices; shown to administrators and while the app is configured. */
  devices: {
    initial: z.infer<typeof AppDevicesPageSchema> | null;
    availability: ApprovalAvailability;
    admin: boolean;
    pairing?: { userId: string; name: string; appOrigin: string };
  } | null;
  /** The phones of the mobile app, while the installation offers it. */
  phones: { devices: PwaDeviceView[]; dateConfig: DateContext; summary: string } | null;
  apiKeys: { keys: ServiceAccountCredential[]; openAiBaseUrl: string | null; mcpEndpoint: string; cloudUrl: string };
  now: string;
};

/** The phones of the mobile app as a section, with its dialog. */
const Phones = (props: { userId: string; phones: NonNullable<SecurityScreenProps["phones"]> }) => {
  const phones = useAppDevices({
    userId: props.userId,
    initial: props.phones.devices,
    dateConfig: props.phones.dateConfig,
    summary: props.phones.summary,
  });
  return (
    <>
      {phones.section()}
      {phones.dialog()}
    </>
  );
};

/**
 * `/me/security` on v2, the account's "Security & devices": passkeys, the sign-in app's devices, the phones of the
 * mobile app and the API keys in the main column; password, sign-out and deletion beside them.
 */
export default function SecurityScreen(props: SecurityScreenProps) {
  const keys = useApiKeys({
    initialKeys: props.apiKeys.keys,
    openAiBaseUrl: props.apiKeys.openAiBaseUrl,
    now: props.now,
    connect: { mcpEndpoint: props.apiKeys.mcpEndpoint, cloudUrl: props.apiKeys.cloudUrl },
  });
  return (
    <AccountWorkspace user={props.user} place="account">
      <Pane label={props.user.name} head={<AccountTabs active="security" />}>
        <Pane.Split>
          <Pane label={props.user.name}>
            <PasskeysSection initialPasskeys={props.passkeys} now={props.now} />
            <Show when={props.devices}>{(devices) => <DevicesSection {...devices()} />}</Show>
            <Show when={props.phones}>{(phones) => <Phones userId={props.userId} phones={phones()} />}</Show>
            {keys.section()}
          </Pane>
          <Pane side label={props.user.name} width={sideWidth}>
            <SignInSection userId={props.userId} provider={props.provider} profile={props.profile} freeIpaEnabled={props.freeIpaEnabled} />
          </Pane>
        </Pane.Split>
      </Pane>
      {keys.dialogs()}
    </AccountWorkspace>
  );
}
