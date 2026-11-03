import { Button, toast, useLocale } from "@k2b/ui";
import { codePageMessages } from "./messages";

/** The normal Code page and its refusal notice use the same non-secret account handle. */
export function CodeAccountHandle(props: { handle: string }) {
  const locale = useLocale();
  const t = () => codePageMessages.resolve([locale()]).t;
  return (
    <div class="flex flex-wrap items-center gap-2">
      <code class="break-all text-sm text-secondary">{props.handle}</code>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(props.handle);
            toast.success(t().handleCopied);
          } catch {
            toast.error(t().handleCopyFailed);
          }
        }}
      >
        <i class="ti ti-copy" aria-hidden="true" />
        {t().copyHandle}
      </Button>
    </div>
  );
}
