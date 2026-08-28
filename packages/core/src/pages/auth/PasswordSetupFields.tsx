import { i18n, password } from "@k2b/stdlib";
import { clipboard } from "@k2b/stdlib/solid";
import { Button, prompts, TextInput, useLocale } from "@k2b/ui";
import { type Accessor, createMemo, createSignal } from "solid-js";

type PasswordSetupFieldsProps = {
  newPassword: Accessor<string>;
  confirmPassword: Accessor<string>;
  onNewPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  locale?: string;
};

export const passwordSetupMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      generatedPassword: "Generated password",
      generatedPasswordDescription:
        "The generated password was filled into both password fields. Copy it now if you want to store it in a password manager.",
      copied: "Copied",
      copyPassword: "Copy password",
      done: "Done",
      passwordGenerated: "Password generated",
      newPassword: "New password",
      newPasswordDescription: "Choose a strong password or generate one automatically.",
      generate: "Generate",
      noPassword: "No password yet",
      minimumLength: "Use at least 12 characters.",
      estimatedCrackTime: ({ time }: { time: string }) => `Estimated crack time: ${time}`,
      generatedFilled: "Generated password filled into both password fields. Use the eye icon to review it before saving.",
      confirmPassword: "Confirm new password",
      confirmPasswordDescription: "Repeat the new password to avoid typos.",
      strength0: "very weak",
      strength1: "weak",
      strength2: "fair",
      strength3: "strong",
      strength4: "very strong",
      germanStrengthAdvice: "A longer, randomly generated password is harder to guess.",
    },
    de: {
      generatedPassword: "Erzeugtes Passwort",
      generatedPasswordDescription:
        "Das erzeugte Passwort wurde in beide Passwortfelder eingetragen. Kopiere es jetzt, wenn du es in einem Passwortmanager speichern möchtest.",
      copied: "Kopiert",
      copyPassword: "Passwort kopieren",
      done: "Fertig",
      passwordGenerated: "Passwort erzeugt",
      newPassword: "Neues Passwort",
      newPasswordDescription: "Wähle ein starkes Passwort oder erzeuge automatisch eines.",
      generate: "Erzeugen",
      noPassword: "Noch kein Passwort",
      minimumLength: "Verwende mindestens 12 Zeichen.",
      estimatedCrackTime: ({ time }) => `Geschätzte Zeit zum Knacken: ${time}`,
      generatedFilled: "Das erzeugte Passwort wurde in beide Felder eingetragen. Prüfe es vor dem Speichern über das Augensymbol.",
      confirmPassword: "Neues Passwort bestätigen",
      confirmPasswordDescription: "Wiederhole das neue Passwort, um Tippfehler zu vermeiden.",
      strength0: "sehr schwach",
      strength1: "schwach",
      strength2: "mittel",
      strength3: "stark",
      strength4: "sehr stark",
      germanStrengthAdvice: "Ein längeres, zufällig erzeugtes Passwort ist schwerer zu erraten.",
    },
  },
});

function GeneratedPasswordDialog(props: { password: string; close: () => void; locale?: string }) {
  const inheritedLocale = useLocale();
  const t = () => passwordSetupMessages.resolve([props.locale ?? inheritedLocale()]).t;
  const { copy, wasCopied } = clipboard.create(2500);
  const [copiedOnce, setCopiedOnce] = createSignal(false);

  const copyPassword = async () => {
    await copy(props.password);
    setCopiedOnce(true);
  };

  return (
    <div class="flex flex-col gap-4">
      <div class="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <p class="text-xs font-medium uppercase tracking-wide text-dimmed">{t().generatedPassword}</p>
        <p class="mt-2 break-all font-mono text-sm text-primary">{props.password}</p>
      </div>

      <p class="text-sm text-dimmed">{t().generatedPasswordDescription}</p>

      <div class="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => void copyPassword()}>
          <i class={wasCopied() ? "ti ti-clipboard-check" : "ti ti-copy"} />
          {wasCopied() ? t().copied : t().copyPassword}
        </Button>
        {copiedOnce() && (
          <Button type="button" size="sm" onClick={props.close}>
            {t().done}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Reusable new-password fields for expired-password and reset-token flows. */
export function PasswordSetupFields(props: PasswordSetupFieldsProps) {
  const inheritedLocale = useLocale();
  const resolved = () => passwordSetupMessages.resolve([props.locale ?? inheritedLocale()]);
  const t = () => resolved().t;
  const [generatedPassword, setGeneratedPassword] = createSignal(false);

  const strength = createMemo(() => password.strength(props.newPassword()));
  const strengthPercent = () => (props.newPassword().length === 0 ? 0 : ((strength().score + 1) / 5) * 100);
  const strengthColor = () => {
    const score = strength().score;
    if (score <= 1) return "bg-red-500";
    if (score === 2) return "bg-amber-500";
    if (score === 3) return "bg-emerald-500";
    return "bg-green-600";
  };
  const strengthTextColor = () => {
    const score = strength().score;
    if (score <= 1) return "text-red-600 dark:text-red-400";
    if (score === 2) return "text-amber-600 dark:text-amber-400";
    return "text-emerald-600 dark:text-emerald-400";
  };

  const generatePassword = async () => {
    const next = password.random({
      length: 24,
      uppercase: true,
      numbers: true,
      symbols: false,
    });
    props.onNewPasswordChange(next);
    props.onConfirmPasswordChange(next);
    setGeneratedPassword(true);
    await prompts.dialog<void>((close) => <GeneratedPasswordDialog password={next} close={close} locale={props.locale} />, {
      title: t().passwordGenerated,
      icon: "ti ti-sparkles",
      size: "small",
    });
  };

  const updateNewPassword = (value: string) => {
    props.onNewPasswordChange(value);
    setGeneratedPassword(false);
  };

  return (
    <div class="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/70">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-sm font-medium text-primary">{t().newPassword}</p>
          <p class="text-xs text-dimmed">{t().newPasswordDescription}</p>
        </div>
        <Button type="button" variant="secondary" size="sm" class="shrink-0" onClick={() => void generatePassword()}>
          <i class="ti ti-sparkles" />
          {t().generate}
        </Button>
      </div>

      <TextInput
        placeholder={t().newPassword}
        icon="ti ti-lock-open"
        password
        value={props.newPassword}
        onValueChange={updateNewPassword}
        autocomplete="new-password"
        aria-label={t().newPassword}
      />

      <div class="flex flex-col gap-1.5">
        <div class="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" aria-hidden="true">
          <div
            class={`h-full rounded-full transition-[width,background-color] ${strengthColor()}`}
            style={{ width: `${strengthPercent()}%` }}
          />
        </div>
        <div class="flex items-start justify-between gap-3 text-xs">
          <p class={`font-medium capitalize ${props.newPassword().length === 0 ? "text-dimmed" : strengthTextColor()}`}>
            {props.newPassword().length === 0
              ? t().noPassword
              : [t().strength0, t().strength1, t().strength2, t().strength3, t().strength4][strength().score]}
          </p>
          <p class="text-right text-dimmed">
            {props.newPassword().length === 0
              ? t().minimumLength
              : resolved().locale === "de"
                ? t().germanStrengthAdvice
                : t().estimatedCrackTime({ time: strength().crackTime })}
          </p>
        </div>
        {generatedPassword() && <p class="text-xs text-dimmed">{t().generatedFilled}</p>}
        {!generatedPassword() && resolved().locale !== "de" && props.newPassword().length > 0 && strength().feedback.length > 0 && (
          <p class="text-xs text-dimmed">{strength().feedback.slice(0, 2).join(". ")}.</p>
        )}
      </div>

      <TextInput
        label={t().confirmPassword}
        description={t().confirmPasswordDescription}
        placeholder={t().confirmPassword}
        icon="ti ti-lock-check"
        password
        value={props.confirmPassword}
        onValueChange={props.onConfirmPasswordChange}
        autocomplete="new-password"
      />
    </div>
  );
}
