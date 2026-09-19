import { MultiSelectInput, Select, Switch } from "@k2b/ui";
import { Show } from "solid-js";
import type { CustomAppTablePresentation } from "../../../custom-apps/contracts";
import { type CustomAppBuilderText, useCustomAppBuilderMessages } from "./builder-messages";

type Column = { id: string; label: string; dateOnly: boolean };

export function RecordsPresentationEditor(props: {
  value: CustomAppTablePresentation;
  columns: Column[];
  onChange: (value: CustomAppTablePresentation) => void;
}) {
  const messages = useCustomAppBuilderMessages();
  const text = (value: CustomAppBuilderText) => messages().text({ value });
  return (
    <div class="flex flex-col gap-4">
      <MultiSelectInput
        label={text("Relative dates")}
        description={text("Show today, tomorrow, or the calendar-day distance beside date-only values.")}
        options={props.columns.filter((column) => column.dateOnly)}
        value={() => props.value.relativeDateColumnIds ?? []}
        onValueChange={(relativeDateColumnIds) => props.onChange({ ...props.value, relativeDateColumnIds })}
        clearable
      />
      <Switch
        label={text("Compact mobile rows")}
        description={text("Choose the heading and facts shown on narrow screens. Row actions stay available.")}
        value={() => Boolean(props.value.mobile)}
        disabled={props.columns.length === 0}
        onValueChange={(enabled) =>
          props.onChange({
            ...props.value,
            mobile:
              enabled && props.columns[0]
                ? {
                    titleColumnId: props.columns[0].id,
                    detailColumnIds: props.columns.slice(1).map((column) => column.id),
                  }
                : undefined,
          })
        }
      />
      <Show when={props.value.mobile}>
        {(mobile) => (
          <>
            <Select
              label={text("Mobile row heading")}
              options={props.columns}
              value={() => mobile().titleColumnId}
              onValueChange={(titleColumnId) =>
                titleColumnId &&
                props.onChange({
                  ...props.value,
                  mobile: {
                    titleColumnId,
                    detailColumnIds: mobile().detailColumnIds.filter((id) => id !== titleColumnId),
                  },
                })
              }
            />
            <MultiSelectInput
              label={text("Mobile row details")}
              options={props.columns.filter((column) => column.id !== mobile().titleColumnId)}
              value={() => mobile().detailColumnIds}
              onValueChange={(detailColumnIds) => props.onChange({ ...props.value, mobile: { ...mobile(), detailColumnIds } })}
              clearable
            />
          </>
        )}
      </Show>
    </div>
  );
}
