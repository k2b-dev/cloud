import { Button, Switch, useLocale } from "@k2b/ui";
import { Show } from "solid-js";
import { aiDetailControls } from "./detail-controls";
import { aiAreaMessages } from "./messages";

/**
 * Active, Test and Save in the detail level's head. Until the detail island registers, the controls keep their
 * place disabled, so the head does not shift when it hydrates.
 */
export default function AiDetailActions(props: { enabled?: boolean; test?: boolean }) {
  const locale = useLocale();
  const t = () => aiAreaMessages.resolve([locale()]).t;
  const controls = aiDetailControls;
  return (
    <div class="flex items-center gap-2">
      <Show when={props.enabled}>
        <Switch
          label={t().active}
          value={() => controls()?.enabled?.value ?? true}
          disabled={!controls()?.enabled || controls()?.enabled?.disabled || controls()?.save.saving}
          onValueChange={(value) => controls()?.enabled?.onChange(value)}
        />
      </Show>
      <Show when={props.test}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={controls()?.test?.busy}
          disabled={!controls()?.test || controls()?.test?.disabled || controls()?.save.saving}
          onClick={() => controls()?.test?.run()}
        >
          <i class="ti ti-player-play" aria-hidden="true" />
          {controls()?.test?.label ?? t().testModel}
        </Button>
      </Show>
      <Button
        type="button"
        size="sm"
        loading={controls()?.save.saving}
        loadingLabel={t().saving}
        disabled={!controls()?.save.dirty || controls()?.save.disabled}
        onClick={() => controls()?.save.run()}
      >
        <i class="ti ti-check" aria-hidden="true" />
        {t().save}
      </Button>
    </div>
  );
}
