import { createEffect, createSignal, createUniqueId, For, Show } from "solid-js";
import { Button } from "../actions/Button";
import { FilterChip } from "../actions/FilterChip";
import { Slider } from "../inputs/ChoiceInputs";
import { useUiMessages } from "../intl/messages";
import type { ChartExplorerRequest } from "./chart-explorer";

export type ChartFilterControlsProps = {
  request: ChartExplorerRequest;
  displayedRequest: ChartExplorerRequest;
  steps?: readonly { key: string; label: string }[];
  series?: readonly { key: string; label: string; color: string }[];
  dimensionLabel?: string;
  disabled?: boolean;
  failed?: boolean;
  onRequest: (request: ChartExplorerRequest) => void;
  onRetry?: () => void;
};

/** Shared controls for a standalone explorer or an atomic group of charts. */
export function ChartFilterControls(props: ChartFilterControlsProps) {
  const validateOptions = () => {
    for (const items of [props.steps, props.series]) {
      const keys = items?.map((item) => item.key) ?? [];
      if (keys.some((key) => !key) || new Set(keys).size !== keys.length)
        throw new Error("Chart control options require nonempty unique keys");
    }
  };
  validateOptions();
  createEffect(validateOptions);
  const messages = useUiMessages();
  const id = `k2b-chart-controls-${createUniqueId()}`;
  const [keyboardSteps, setKeyboardSteps] = createSignal(false);
  let pointerFocus = false;
  const stepLabel = (key: string | undefined) => props.steps?.find((step) => step.key === key)?.label ?? key ?? "";
  return (
    <>
      <Show when={props.steps?.length}>
        <div
          class="k2b-chart-explorer__dimension"
          role="group"
          aria-label={props.dimensionLabel ?? messages().range}
          data-keyboard={keyboardSteps() ? "true" : undefined}
          onPointerDown={() => {
            pointerFocus = true;
            setKeyboardSteps(false);
          }}
          onKeyDown={() => {
            pointerFocus = false;
            setKeyboardSteps(true);
          }}
          onFocusIn={(event) => {
            if (!pointerFocus && event.target.matches(":focus-visible")) setKeyboardSteps(true);
          }}
          onFocusOut={() => {
            pointerFocus = false;
            setKeyboardSteps(false);
          }}
        >
          <Slider
            id={`${id}-dimension`}
            showValue={false}
            aria-describedby={`${id}-steps`}
            label={props.dimensionLabel ?? messages().range}
            min={0}
            max={Math.max(0, (props.steps?.length ?? 1) - 1)}
            step={1}
            value={Math.max(0, props.steps?.findIndex((step) => step.key === props.request.step) ?? 0)}
            disabled={props.disabled || (props.steps?.length ?? 0) < 2}
            formatValue={(index) => props.steps?.[index]?.label ?? ""}
            aria-valuetext={stepLabel(props.request.step)}
            onValueChange={(index) => {
              const step = props.steps?.[index];
              if (step) props.onRequest({ ...props.request, step: step.key });
            }}
          />
          <output class="k2b-chart-explorer__dimension-value" for={`${id}-dimension`}>
            {stepLabel(props.request.step)}
          </output>
          <div id={`${id}-steps`} class="k2b-chart-explorer__steps">
            <For each={props.steps}>
              {(step) => <span data-current={step.key === props.request.step ? "true" : undefined}>{step.label}</span>}
            </For>
          </div>
        </div>
      </Show>
      <div class="k2b-chart-explorer__legend">
        <Show when={props.series?.length}>
          <FilterChip
            label={messages().chartSeries}
            icon="ti ti-chart-dots"
            disabled={props.disabled}
            value={props.request.visibleKeys ?? props.series?.map((item) => item.key) ?? []}
            defaultValue={props.series?.map((item) => item.key) ?? []}
            isActive={props.request.visibleKeys !== undefined && props.request.visibleKeys.length !== props.series?.length}
            options={[
              { multiple: true, options: (props.series ?? []).map((item) => ({ value: item.key, label: item.label, color: item.color })) },
            ]}
            onValueChange={(visibleKeys) => props.onRequest({ ...props.request, visibleKeys })}
          />
        </Show>
        <div class="k2b-chart-explorer__status" role="status">
          <Show when={props.failed}>
            {messages().couldNotLoadData}{" "}
            <Button variant="text" size="sm" onClick={props.onRetry}>
              {messages().retry}
            </Button>
          </Show>
          <Show when={props.failed}>
            · {messages().chartPreviousData}
            <Show when={props.steps?.length}>: {stepLabel(props.displayedRequest.step)}</Show>
          </Show>
        </div>
      </div>
    </>
  );
}
