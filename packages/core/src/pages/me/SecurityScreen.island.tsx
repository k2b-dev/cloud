import type { AppDevicesPageSchema, UserProfile, UserProvider, WebAuthnPasskey } from "@k2b/cloud/contracts";
import { Pane } from "@k2b/ui/v2";
import { Show } from "solid-js";
import type { z } from "zod";
import type { ApprovalAvailability } from "../app-approval/availability";
import DevicesSection from "../app-approval/DevicesSection";
import AccountWorkspace, { useAccountMessages } from "./AccountWorkspace";
import type { AccountUserView } from "./account-view";
import PasskeysSection from "./PasskeysSection";
import SecurityTabs from "./SecurityTabs";
import SignInSection from "./SignInSection";

export type SecurityScreenProps = {
  user: AccountUserView;
  appTab: boolean;
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
  now: string;
};

/** `/me/security` on v2: the sign-in app's devices, passkeys, and the password, sign-out and deletion deeds. */
export default function SecurityScreen(props: SecurityScreenProps) {
  const t = useAccountMessages();
  return (
    <AccountWorkspace user={props.user} active="security" appTab={props.appTab}>
      <Pane label={t().security} head={<SecurityTabs active="sign-in" />}>
        <Show when={props.devices}>{(devices) => <DevicesSection {...devices()} />}</Show>
        <PasskeysSection initialPasskeys={props.passkeys} now={props.now} />
        <SignInSection userId={props.userId} provider={props.provider} profile={props.profile} freeIpaEnabled={props.freeIpaEnabled} />
      </Pane>
    </AccountWorkspace>
  );
}
