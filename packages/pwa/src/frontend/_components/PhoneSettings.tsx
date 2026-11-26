import { pwaDrafts } from "@k2b/cloud/browser/pwa-drafts";
import { reloadOnce } from "@k2b/cloud/browser/reload";
import type { CloudThemePreference } from "@k2b/cloud/shared";
import { createPreferenceController, THEME_CYCLE } from "@k2b/cloud/ssr/preference-controller";
import { useLocale } from "@k2b/ui";
import { Button, Icon, Input, Menu, Notice, NoticeStack, Row, Section, useToast } from "@k2b/ui/v2";
import { createSignal, onMount, Show } from "solid-js";
import { shellMessages } from "../../messages";
import { phoneAuth } from "../phone";
import { askToSignOut, signOutOfApp } from "./sign-out";

export type PhoneSettingsProps = {
  /** The signed-in person; their id keys the drafts of this page. */
  account: { id: string };
  theme: CloudThemePreference;
  /** The longest name a phone takes (`PWA_LIMITS.nameMaxLength`), from the page: the island loads no contract schemas. */
  nameMaxLength: number;
  /** This phone's name; empty when the request carries no device. */
  name: string;
  cloud: string;
  /** The release line, where the device's pairing date is not known. */
  version: string;
  /** When this phone was paired, in the person's format; absent without a device. */
  pairedSince?: string;
};

/** Where the account, security and the other devices are set: Cloud's own settings. */
const ALL_SETTINGS = "/me";
/** The marks of the three parts: this device, the Cloud, and how the app looks. */
const DEVICE = "#64748b";
const CLOUD = "#be185d";
const LOOK = "#7c3aed";

const iconName = (icon: string) => icon.replace(/^ti\s+ti-/, "");

/**
 * The app's Settings inside its frame, for this device only: its name and signing it out, the way to Cloud's own
 * settings for the account and the other devices, and how the app looks. Each row says what it sets on the left and
 * holds its control on the right (k2b-ui gap: the v2 `Setting` row of #4223 takes over once it lands).
 */
export default function PhoneSettings(props: PhoneSettingsProps) {
  const locale = useLocale();
  const t = () => shellMessages.resolve([locale()]).t;
  const toast = useToast();
  // The web's preference model: it writes the same cookies and announces theme changes, on which the app runtime
  // repaints the status bar.
  const preferences = createPreferenceController(props.theme, locale);
  const words = preferences.messages;
  const [name, setName] = createSignal(props.name);
  const [saved, setSaved] = createSignal(props.name);
  const [error, setError] = createSignal<string>();
  const [problem, setProblem] = createSignal<string>();
  const [draftLost, setDraftLost] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [signingOut, setSigningOut] = createSignal(false);
  const [ready, setReady] = createSignal(false);

  const field = "pwa.settings.device-name";
  let nameInput: HTMLInputElement | HTMLTextAreaElement | undefined;
  onMount(() => {
    if (nameInput) nameInput.defaultValue = props.name;
    const draft = pwaDrafts.read(props.account.id, field);
    if (draft === props.name) pwaDrafts.remove(props.account.id, field);
    setName(draft ?? props.name);
    setReady(true);
  });

  const changed = () => name().trim() !== saved();
  const rename = async () => {
    if (saving() || !changed()) return;
    const submitted = name();
    const value = submitted.trim();
    if (!value || value.length > props.nameMaxLength) return setError(t().nameInvalid);
    setSaving(true);
    setProblem(undefined);
    const answer = await phoneAuth.rename(value);
    setSaving(false);
    if (answer.status === 204) {
      setSaved(value);
      if (nameInput) nameInput.defaultValue = value;
      // A person can keep typing while a save is in flight. Only the submitted text was saved; whatever differs from
      // it now stays a draft, also text that matches the name before the save.
      if (name() === submitted) setName(value);
      if (name() === value) pwaDrafts.remove(props.account.id, field);
      else pwaDrafts.write(props.account.id, field, name());
      toast(t().nameSaved, { status: "ok" });
    } else if (answer.status === 401) reloadOnce("pwa-auth");
    else if (answer.status === 400) setError(t().nameInvalid);
    else setProblem(answer.status === 0 ? t().offline : t().failed);
  };

  // one question and one request at a time, however often the button is pressed
  const signOut = async () => {
    if (signingOut()) return;
    setSigningOut(true);
    // a question that cannot load says so; the button works again
    const agreed = await askToSignOut(t(), props.cloud).catch(() => null);
    const failed = agreed === null ? t().failed : agreed ? await signOutOfApp(t()) : undefined;
    setProblem(failed);
    if (!agreed || failed) setSigningOut(false);
  };

  const language = () => (preferences.language() === "de" ? "Deutsch" : "English");
  const theme = () => preferences.themeOption(preferences.theme());

  return (
    <>
      {/* this device first: its name and signing it out are what a phone comes here for */}
      <Section icon="device-mobile" color={DEVICE} title={t().thisPhone}>
        <Row
          icon="device-mobile"
          color={DEVICE}
          lines={[saved() || t().noName, props.pairedSince ? t().pairedSince({ date: props.pairedSince }) : props.version]}
          end={
            <Button icon="logout" keep busy={signingOut()} onClick={() => void signOut()}>
              {t().signOut}
            </Button>
          }
        />
        <Row
          icon="pencil"
          color={DEVICE}
          lines={error() ? [t().phoneName, error()] : [t().phoneName]}
          end={
            <>
              <Input
                ref={(element) => {
                  nameInput = element;
                }}
                label={t().phoneName}
                value={name()}
                placeholder={t().phoneNamePlaceholder}
                maxLength={props.nameMaxLength}
                autocomplete="off"
                disabled={!ready()}
                onInput={(value) => {
                  setName(value);
                  if (value === saved()) pwaDrafts.remove(props.account.id, field);
                  else if (!pwaDrafts.write(props.account.id, field, value)) setDraftLost(true);
                  setError(undefined);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.isComposing) {
                    event.preventDefault();
                    void rename();
                  }
                }}
              />
              {/* the symbol alone, so the row's name keeps its room beside the field on a phone */}
              <Button icon="check" label={t().save} busy={saving()} disabled={!changed()} onClick={() => void rename()} />
            </>
          }
        />
      </Section>
      {/* the account, security and the other devices live in Cloud's own settings: one clear way there */}
      <Section icon="cloud" color={CLOUD} title={props.cloud}>
        <Row
          icon="settings"
          color={CLOUD}
          lines={[t().allSettings, t().allSettingsHint]}
          end={<Icon name="external-link" />}
          href={ALL_SETTINGS}
        />
      </Section>
      <Section icon="palette" color={LOOK} title={t().appearanceSection}>
        <Row
          icon={iconName(theme().icon)}
          color={LOOK}
          lines={[t().lookRow]}
          end={
            <Menu
              label={words().appearance({ current: theme().label })}
              items={[
                {
                  title: t().appearance,
                  choice: preferences.theme(),
                  onChoose: (value: string) => {
                    const next = THEME_CYCLE.find((mode) => mode === value);
                    if (next) preferences.setTheme(next);
                  },
                  items: THEME_CYCLE.map((mode) => ({
                    value: mode,
                    label: preferences.themeOption(mode).label,
                    icon: iconName(preferences.themeOption(mode).icon),
                  })),
                },
              ]}
            >
              {theme().label}
            </Menu>
          }
        />
        <Row
          icon="language"
          color={LOOK}
          lines={[t().language]}
          end={
            <Menu
              label={`${t().language}: ${language()}`}
              items={[
                {
                  title: t().language,
                  choice: preferences.language(),
                  onChoose: (value: string) => {
                    if (value !== preferences.language()) preferences.toggleLanguage();
                  },
                  items: [
                    { value: "en", label: "English" },
                    { value: "de", label: "Deutsch" },
                  ],
                },
              ]}
            >
              {language()}
            </Menu>
          }
        />
      </Section>
      {/* what comes after the page has drawn floats over it, so nothing on the page moves */}
      <NoticeStack>
        <Show when={draftLost()}>
          <Notice tone="warn" actions={[{ label: t().hide, onClick: () => setDraftLost(false) }]}>
            {t().draftUnavailable}
          </Notice>
        </Show>
        <Show when={problem()}>
          {(text) => (
            <Notice tone="bad" actions={[{ label: t().hide, onClick: () => setProblem(undefined) }]}>
              {text()}
            </Notice>
          )}
        </Show>
      </NoticeStack>
    </>
  );
}
