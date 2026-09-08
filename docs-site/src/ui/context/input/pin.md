# PinInput

`PinInput` edits a short numeric code as separate digit fields. The parent owns the code, verification, errors, and submission.

## Use PinInput

Use it for numeric PINs and one-time verification codes with a known length.

Use `TextInput` when the value may contain letters or its length is not fixed.

## Import

```tsx
import { PinInput } from "@k2b/ui";
```

## State and behavior

Pass the current code directly or through a Solid accessor.
`onValueChange` receives every partial code. `onValueCommit` runs once the
configured number of digits is complete.

`length` defaults to `6`. Input is restricted to digits. Typing advances focus, Backspace can move to and clear the previous field, arrow keys move between fields, and pasted digits fill the remaining fields.

Set `password` to mask each digit for a reusable secret such as an app PIN.
The default keeps digits visible for verification codes. `onSubmit` handles Enter;
the parent still validates the complete value before submitting.

Use `readOnly` to temporarily prevent edits without disabling or blurring the
focused digit, for example while checking a PIN.

Set `stretch` when the fields should divide the available width. `description`, `error`, `required`, and `disabled` follow the shared input behavior.

## Accessibility

Each digit has an accessible position such as “PIN digit 2 of 6”. Provide a visible `label` so the code's purpose is clear beside the group.

Do not use the separated visual fields as a security boundary. Validate the complete code on the server.

## Runtime

Focus movement and paste handling require hydrated Solid client code.

## Example

```tsx
const [code, setCode] = createSignal("");

<PinInput
  label="One-time code"
  length={6}
  value={code}
  onValueChange={setCode}
  required
/>;
```
