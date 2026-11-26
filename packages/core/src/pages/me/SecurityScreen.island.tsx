import type {
  AppDevicesPageSchema,
  PwaDeviceView,
  ServiceAccountCredential,
  UserProfile,
  UserProvider,
  WebAuthnPasskey,
} from "@k2b/cloud/contracts";
import { type DateContext, dates } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Cells, Chip, Empty, Pane, Row, Section } from "@k2b/ui/v2";
import { For, Show } from "solid-js";
import type { z } from "zod";
import type { ApprovalAvailability } from "../app-approval/availability";
import DevicesSection from "../app-approval/DevicesSection";
import AccountWorkspace, { sideWidth, useAccountMessages } from "./AccountWorkspace";
import { useApiKeys } from "./ApiKeysSection";
import { useAppDevices } from "./AppDevicesSection";
import type { AccountUserView } from "./account-view";
import { ACCOUNT_KINDS } from "./kinds";
import PasskeysSection from "./PasskeysSection";
import { ACCOUNT_ACTIVITY_PATH } from "./paths";
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
  apiKeys: {
    keys: ServiceAccountCredential[];
    openAiBaseUrl: string | null;
    mcpEndpoint: string;
    cloudUrl: string;
    /** The person's zone: a key expires at the end of the chosen day there. */
    timeZone: string;
  };
  now: string;
  /** The newest few entries of the account's activity, their time formatted relative to the page's time. */
  recent: { label: string; context: string; when: string; mark: { icon: string; color: string }; refused: boolean }[];
  /** A FreeIPA password's end, formatted, and whether it is near; null without one. */
  password: { value: string; soon: boolean } | null;
};

const SOON_MS = 30 * 24 * 60 * 60 * 1000;

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
  const t = useAccountMessages();
  const locale = useLocale();
  const keys = useApiKeys({
    initialKeys: props.apiKeys.keys,
    openAiBaseUrl: props.apiKeys.openAiBaseUrl,
    now: props.now,
    timeZone: props.apiKeys.timeZone,
    connect: { mcpEndpoint: props.apiKeys.mcpEndpoint, cloudUrl: props.apiKeys.cloudUrl },
  });
  // What asks for a deed soon: the keys that stop working within 30 days, from the live list.
  const expiring = () => {
    const base = Date.parse(props.now);
    return keys
      .list()
      .filter((key) => key.status === "active" && key.expiresAt !== null)
      .map((key) => key.expiresAt as string)
      .filter((at) => Date.parse(at) > base && Date.parse(at) - base < SOON_MS)
      .sort();
  };
  return (
    <AccountWorkspace user={props.user} place="security">
      <Pane label={t().securityAndDevices}>
        <Cells>
          <Show when={props.password}>
            {(password) => (
              <Cells.Cell
                icon={ACCOUNT_KINDS.password.icon}
                color={ACCOUNT_KINDS.password.color}
                label={t().passwordValidUntil}
                value={password().soon ? <Chip status="warn">{password().value}</Chip> : password().value}
              />
            )}
          </Show>
          <Cells.Cell
            icon={ACCOUNT_KINDS.apiKey.icon}
            color={ACCOUNT_KINDS.apiKey.color}
            label={t().keysExpiringSoon}
            value={expiring().length > 0 ? <Chip status="warn">{t().expiringCount({ count: expiring().length })}</Chip> : t().noneIn30Days}
            meta={expiring()[0] ? t().nextKeyExpiry({ date: dates.formatDate(expiring()[0] as string, { locale: locale() }) }) : undefined}
          />
        </Cells>
        <Pane.Split>
          <Pane label={props.user.name}>
            <PasskeysSection initialPasskeys={props.passkeys} now={props.now} />
            <Show when={props.devices}>{(devices) => <DevicesSection {...devices()} />}</Show>
            <Show when={props.phones}>{(phones) => <Phones userId={props.userId} phones={phones()} />}</Show>
            {keys.section()}
          </Pane>
          <Pane side label={props.user.name} width={sideWidth}>
            <SignInSection userId={props.userId} provider={props.provider} profile={props.profile} freeIpaEnabled={props.freeIpaEnabled} />
            <Section
              icon="activity"
              title={t().recently}
              more={{ label: t().viewAll, href: `${ACCOUNT_ACTIVITY_PATH}?kind=sign-ins`, forward: true }}
            >
              <Show when={props.recent.length > 0} fallback={<Empty icon="clipboard-list" text={t().noRecentAccountActivity} />}>
                <For each={props.recent}>
                  {(entry) => (
                    <Row
                      mark={entry.mark}
                      lines={[entry.label, entry.context]}
                      time={entry.when}
                      marks={entry.refused ? <Chip status="warn">{t().refused}</Chip> : undefined}
                    />
                  )}
                </For>
              </Show>
            </Section>
          </Pane>
        </Pane.Split>
      </Pane>
      {keys.dialogs()}
    </AccountWorkspace>
  );
}
