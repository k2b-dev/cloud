import { Button, CopyButton, IconButton, prompts } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { useAccountsMessages } from "../messages";

type Props = {
  displayName: string;
  uid: string;
  mail?: string | null;
  previousProvider?: string | null;
  previousProfile?: string | null;
  reason: string;
  deletedAt: string;
  metadata: Record<string, unknown> | null;
};

export default function DeletedAccountDetails(props: Props) {
  const messages = useAccountsMessages();
  const open = async () => {
    await prompts.dialog<void>(
      (close) => (
        <div class="flex flex-col gap-4">
          <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
            <span class="text-dimmed">{messages().account}</span>
            <span class="text-primary">{props.displayName}</span>
            <span class="text-dimmed">UID</span>
            <span class="text-primary">{props.uid}</span>
            <span class="text-dimmed">{messages().email}</span>
            <span class="text-primary">{props.mail || "-"}</span>
            <span class="text-dimmed">{messages().provider}</span>
            <span class="text-primary">{props.previousProvider || "-"}</span>
            <span class="text-dimmed">{messages().profile}</span>
            <span class="text-primary">{props.previousProfile || "-"}</span>
            <span class="text-dimmed">{messages().reason}</span>
            <span class="text-primary">{props.reason}</span>
            <span class="text-dimmed">{messages().deleted}</span>
            <span class="text-primary">{props.deletedAt}</span>
          </div>
          <MetadataDetail metadata={props.metadata} />
          <div class="flex justify-end">
            <Button size="sm" variant="secondary" onClick={() => close()}>
              {messages().close}
            </Button>
          </div>
        </div>
      ),
      { title: props.displayName, icon: "ti ti-history-toggle", size: "large" },
    );
  };

  return (
    <IconButton size="sm" label={messages().showDetails} onClick={open}>
      <i class="ti ti-eye text-xs" />
    </IconButton>
  );
}

function MetadataDetail(props: { metadata: Record<string, unknown> | null }) {
  const messages = useAccountsMessages();
  const [showRaw, setShowRaw] = createSignal(false);
  const entries: Array<[string, unknown]> = props.metadata ? Object.entries(props.metadata) : [];
  const jsonRaw = JSON.stringify(props.metadata ?? {}, null, 2);

  return (
    <div class="flex flex-col gap-2">
      <span class="text-[10px] uppercase tracking-wider text-dimmed">{messages().metadata}</span>
      <Show
        when={!showRaw()}
        fallback={
          <div class="relative rounded-md bg-zinc-100 px-3 py-2 dark:bg-zinc-800">
            <pre class="max-h-64 overflow-y-auto whitespace-pre-wrap break-all pr-16 text-[11px] text-secondary">{jsonRaw}</pre>
            <div class="absolute right-2 top-2">
              <CopyButton text={jsonRaw} label={messages().copy} />
            </div>
          </div>
        }
      >
        <div class="rounded-md bg-zinc-100 px-3 py-2 dark:bg-zinc-800">
          {props.metadata ? (
            <div class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
              {entries.map(([key, value]) => {
                const isComplex = typeof value === "object" && value !== null;
                const display = isComplex ? JSON.stringify(value) : String(value ?? "null");
                return (
                  <>
                    <span class="shrink-0 font-medium text-dimmed">{key}</span>
                    <span class={`break-all text-secondary ${isComplex ? "font-mono text-[11px]" : ""}`}>{display}</span>
                  </>
                );
              })}
            </div>
          ) : (
            <div class="text-xs text-secondary">{messages().noMetadata}</div>
          )}
        </div>
      </Show>
      <Button
        size="xs"
        variant="ghost"
        class="self-start text-[10px] text-dimmed transition-colors hover:text-secondary"
        onClick={() => setShowRaw(!showRaw())}
      >
        {showRaw() ? messages().viewFormatted : messages().viewRaw}
      </Button>
    </div>
  );
}
