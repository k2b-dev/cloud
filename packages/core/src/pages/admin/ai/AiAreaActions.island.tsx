import { Button, IconButton, useLocale } from "@k2b/ui";
import { onMount } from "solid-js";
import { aiAreaMessages } from "./messages";
import { openAddModels, openAddProvider } from "./provider-dialogs";

/** The area's entry points for B1 and B2; `?o=models` opens the model list right after a provider is saved. */
export default function AiAreaActions(props: {
  kind: "add-provider" | "add-models";
  variant?: "row" | "button" | "icon";
  providerId?: string;
  providerLabel?: string;
  existing?: string[];
}) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const open = () =>
    props.kind === "add-provider"
      ? openAddProvider()
      : openAddModels({ providerId: props.providerId ?? "", providerLabel: props.providerLabel ?? "", existing: props.existing ?? [] });
  onMount(() => {
    if (props.kind !== "add-models" || props.variant !== "button") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("o") !== "models") return;
    params.delete("o");
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
    open();
  });
  const label = () => (props.kind === "add-provider" ? t().addProvider : t().addModels);
  if (props.variant === "icon")
    return (
      <IconButton type="button" variant="ghost" size="sm" label={label()} onClick={open} data-ai-action={props.kind}>
        <i class="ti ti-plus" aria-hidden="true" />
      </IconButton>
    );
  if (props.variant === "row")
    return (
      <Button type="button" variant="text" size="sm" align="start" class="w-full" onClick={open}>
        <i class="ti ti-plus" aria-hidden="true" />
        {label()}
      </Button>
    );
  return (
    <Button
      type="button"
      variant={props.variant === "button" ? "secondary" : "primary"}
      size="sm"
      onClick={open}
      data-ai-action={props.kind}
    >
      <i class="ti ti-plus" aria-hidden="true" />
      {label()}
    </Button>
  );
}
