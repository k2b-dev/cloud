import { Button, TextInput, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { oauthMessages } from "../messages";

const CODE_SYMBOLS = /[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g;

/** Uppercase, drop separators and impossible symbols, and show the code as XXXX-XXXX. */
const formatDeviceCodeInput = (value: string): string => {
  const symbols = value.toUpperCase().replace(CODE_SYMBOLS, "").slice(0, 8);
  return symbols.length > 4 ? `${symbols.slice(0, 4)}-${symbols.slice(4)}` : symbols;
};

/** Code entry for the device approval page. Without JavaScript it is a plain GET form. */
const DeviceCodeForm = (props: { code?: string; error?: string }) => {
  const locale = useLocale();
  const t = () => oauthMessages.resolve([locale()]).t;
  const [code, setCode] = createSignal(formatDeviceCodeInput(props.code ?? ""));

  return (
    <form method="get" action="/oauth/device" class="flex flex-col gap-3">
      <TextInput
        name="user_code"
        label={t().deviceCodeLabel}
        placeholder="XXXX-XXXX"
        icon="ti ti-keyboard"
        value={code}
        onValueChange={(value) => setCode(formatDeviceCodeInput(value))}
        error={props.error}
        maxLength={16}
        autocomplete="one-time-code"
        autocapitalize="characters"
        spellcheck={false}
        autofocus
        monospace
        required
      />
      <Button type="submit">{t().deviceContinue}</Button>
    </form>
  );
};

export default DeviceCodeForm;
