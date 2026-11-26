import { password } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { Button, Dialog, Facts, Field, Input, Progress, Text } from "@k2b/ui/v2";
import { type Accessor, createMemo, createSignal } from "solid-js";
import { passwordSetupMessages } from "./password-setup-messages";

/** How strong a password is, in the meter's tone beside its word: never a colour alone. */
const strengthStatus = (score: number) => (score <= 1 ? ("bad" as const) : score === 2 ? ("warn" as const) : undefined);

/**
 * The new-password fields on a v2 page (reset and expired password): a new password with "Generate" at its end, its
 * strength as a meter and a word, and the repetition. A generated password fills both fields and shows once in a
 * dialog, with a copy button, for a password manager.
 */
export function PasswordSetupFieldsV2(props: {
  newPassword: Accessor<string>;
  confirmPassword: Accessor<string>;
  onNewPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  /** The new password is the form's first field and takes the focus. */
  autofocus?: boolean;
  /** The `id` of the form the fields are sent with. */
  form?: string;
}) {
  const locale = useLocale();
  const resolved = () => passwordSetupMessages.resolve([locale()]);
  const t = () => resolved().t;
  const [generated, setGenerated] = createSignal<string>();
  const [filled, setFilled] = createSignal(false);
  const strength = createMemo(() => password.strength(props.newPassword()));
  const words = () => [t().strength0, t().strength1, t().strength2, t().strength3, t().strength4];

  const generate = () => {
    const next = password.random({ length: 24, uppercase: true, numbers: true, symbols: false });
    props.onNewPasswordChange(next);
    props.onConfirmPasswordChange(next);
    setFilled(true);
    setGenerated(next);
  };
  const advice = () =>
    props.newPassword().length === 0
      ? t().minimumLength
      : filled()
        ? t().generatedFilledBoth
        : resolved().locale === "de"
          ? t().germanStrengthAdvice
          : [t().estimatedCrackTime({ time: strength().crackTime }), ...strength().feedback.slice(0, 2)].join(". ");

  return (
    <>
      <Field label={t().newPassword} hint={t().newPasswordDescription}>
        <Input
          form={props.form}
          icon="lock-open"
          type="password"
          value={props.newPassword()}
          onInput={(value) => {
            props.onNewPasswordChange(value);
            setFilled(false);
          }}
          autocomplete="new-password"
          autofocus={props.autofocus}
          end={<Button variant="ghost" icon="dice" label={t().generate} onClick={generate} />}
        />
      </Field>
      <Facts
        items={[
          {
            label: t().strength,
            value: (
              // one meter from the start, so nothing moves when typing begins: its fill, its tone and its word say the same
              <Progress
                value={props.newPassword().length > 0 ? strength().score + 1 : 0}
                of={5}
                label={props.newPassword().length > 0 ? words()[strength().score] : t().noPassword}
                status={props.newPassword().length > 0 ? strengthStatus(strength().score) : undefined}
              />
            ),
            hint: advice(),
          },
        ]}
      />
      <Field label={t().confirmPassword} hint={t().confirmPasswordDescription}>
        <Input
          form={props.form}
          icon="lock-check"
          type="password"
          value={props.confirmPassword()}
          onInput={props.onConfirmPasswordChange}
          autocomplete="new-password"
        />
      </Field>
      <Dialog
        title={t().passwordGenerated}
        open={generated() !== undefined}
        onOpenChange={(open) => {
          if (!open) setGenerated(undefined);
        }}
        foot={
          <Button variant="primary" onClick={() => setGenerated(undefined)}>
            {t().done}
          </Button>
        }
      >
        <Facts items={[{ label: t().generatedPassword, value: generated() ?? "", mono: true, copy: generated() ?? "" }]} />
        <Text muted>{t().generatedPasswordDescription}</Text>
      </Dialog>
    </>
  );
}
