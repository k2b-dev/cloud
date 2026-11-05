import { Button, useLocale } from "@k2b/ui";
import { copyHandle } from "./CodeRefusalNotice";
import { codePageMessages } from "./messages";

/**
 * "· Handle code-7k2q9m4xwt [Copy]" after the account's name: the normal Code page and Administration › Code show the
 * same non-secret handle. It wraps as one piece, so the separator never ends a line alone.
 */
export function CodeAccountHandle(props: { handle: string }) {
  const locale = useLocale();
  const t = () => codePageMessages.resolve([locale()]).t;
  return (
    <span class="inline-flex flex-wrap items-center gap-x-1 gap-y-0.5">
      <span aria-hidden="true">·</span> {t().handle} <code class="break-all text-sm text-secondary">{props.handle}</code>
      <Button type="button" variant="text" size="sm" aria-label={t().copyHandle} onClick={() => void copyHandle(props.handle, t())}>
        <i class="ti ti-copy" aria-hidden="true" />
        {t().copy}
      </Button>
    </span>
  );
}
