import { Button, useLocale } from "@k2b/ui";
import { copyHandle } from "./CodeRefusalNotice";
import { codePageMessages } from "./messages";

/**
 * "· Handle code-7k2q9m4xwt [Copy]" after the account's name: the normal Code page and Administration › Code show the
 * same non-secret handle. It flows with the sentence: "· Handle" stays together and may end a line, the handle and its
 * Copy button stay together, so the separator never ends a line alone and the handle never splits.
 */
export function CodeAccountHandle(props: { handle: string }) {
  const locale = useLocale();
  const t = () => codePageMessages.resolve([locale()]).t;
  return (
    <>
      <span class="whitespace-nowrap">
        <span aria-hidden="true">·</span> {t().handle}
      </span>{" "}
      <span class="inline-flex items-center gap-x-1 whitespace-nowrap">
        <code data-code-handle="" class="text-[0.92em] text-secondary">
          {props.handle}
        </code>
        <Button type="button" variant="text" size="sm" aria-label={t().copyHandle} onClick={() => void copyHandle(props.handle, t())}>
          <i class="ti ti-copy" aria-hidden="true" />
          {t().copy}
        </Button>
      </span>
    </>
  );
}
