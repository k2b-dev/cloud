import { Button, useLocale } from "@k2b/ui";
import { copyHandle } from "./CodeRefusalNotice";
import { codePageMessages } from "./messages";

/** The normal Code page and its refusal notice use the same non-secret account handle. */
export function CodeAccountHandle(props: { handle: string }) {
  const locale = useLocale();
  const t = () => codePageMessages.resolve([locale()]).t;
  return (
    <span class="inline-flex flex-wrap items-center gap-2">
      <code class="break-all text-sm text-secondary">{props.handle}</code>
      <Button type="button" variant="secondary" size="sm" onClick={() => void copyHandle(props.handle, t())}>
        <i class="ti ti-copy" aria-hidden="true" />
        {t().copyHandle}
      </Button>
    </span>
  );
}
