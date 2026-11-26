import { pwaDrafts } from "@k2b/cloud/browser/pwa-drafts";
import { reloadOnce } from "@k2b/cloud/browser/reload";
import type { CloudThemePreference } from "@k2b/cloud/shared";
import { createPreferenceController, THEME_CYCLE } from "@k2b/cloud/ssr/preference-controller";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Input, List, Menu, Notice, NoticeStack, Row, Text, useToast } from "@k2b/ui/v2";
import { createSignal, onMount, Show } from "solid-js";
import { shellMessages } from "../../messages";
import { phoneAuth } from "../phone";
import { signOutOfApp } from "./sign-out";

export type PhoneSettingsProps = {
  /** The signed-in person, as the page read them. */
  account: { id: string; name: string; mail?: string; avatar?: string };
  theme: CloudThemePreference;
  /** The longest name a phone takes (`PWA_LIMITS.nameMaxLength`), from the page: the island loads no contract schemas. */
  nameMaxLength: number;
  /** This phone's name; empty when the request carries no device. */
  name: string;
  cloud: string;
  /** The release line beside Sign out. */
  version: string;
};

const iconName = (icon: string) => icon.replace(/^ti\s+ti-/, "");

/**
 * The app's Settings inside its frame, as setting rows: each says what it sets on the left and holds its control on
 * the right (k2b-ui gap: the v2 `Setting` row of #4223 takes over once it lands). The account, language, appearance,
 * this phone's name, and signing out at the end.
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
    // the question loads when it is asked: the page draws without the dialog's code
    const { confirmWithBack } = await import("./confirm-with-back");
    const agreed = await confirmWithBack({
      title: t().signOut,
      description: t().signOutConfirm({ cloud: props.cloud }),
      confirm: t().signOut,
    });
    const failed = agreed ? await signOutOfApp(t()) : undefined;
    setProblem(failed);
    if (!agreed || failed) setSigningOut(false);
  };

  const language = () => (preferences.language() === "de" ? "Deutsch" : "English");
  const theme = () => preferences.themeOption(preferences.theme());

  return (
    <>
      <List label={t().account}>
        <Row
          avatar={{ name: props.account.name, image: props.account.avatar }}
          lines={props.account.mail ? [props.account.name, props.account.mail] : [props.account.name]}
        />
      </List>
      <List label={t().settings}>
        <Row
          icon="language"
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
        <Row
          icon={iconName(theme().icon)}
          lines={[t().appearance]}
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
          icon="device-mobile"
          lines={error() ? [t().thisPhone, error()] : [t().thisPhone]}
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
      </List>
      <Bar
        start={<Text type="meta">{props.version}</Text>}
        end={
          <Button icon="logout" busy={signingOut()} onClick={() => void signOut()}>
            {t().signOut}
          </Button>
        }
      />
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
