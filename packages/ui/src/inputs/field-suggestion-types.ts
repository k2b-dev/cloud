// Types only: this file emits no JavaScript, so its documentation costs fields nothing up front.
import type { JSX } from "solid-js";
import type { FieldMeta } from "../internal/field";
import type { FieldProps, MaybeAccessor } from "./field-contract";

/**
 * A value someone or something proposes for a field, such as a value an assistant read from a document. It is
 * plain data: the field shows it and reports acceptance, it never fetches, stores, or submits it.
 */
export type FieldSuggestion<T> =
  | { id: string; state: "loading"; source?: string }
  | { id: string; state: "error"; source?: string; onRetry?: () => void }
  | {
      /** Stable per suggestion and source revision, such as `"re-4471:v3:amount"`. */
      id: string;
      state: "ready";
      value: T;
      /** Only `"high"` takes part in accept-all; `"low"` stays open until someone accepts it on its own. */
      confidence: "high" | "low";
      /** One sentence why the value is uncertain. */
      reason?: string;
      /** How the value reads, when the field cannot name it itself, such as an option from a remote list. */
      label?: string;
      /** Who proposes the value, such as an assistant's name. */
      source?: string;
      /** Set by the owner once the field's value came from this suggestion. */
      accepted?: boolean;
    };

/**
 * Fields that can show a suggestion inside a `SuggestionGroup`, which brings the suggestion code; outside one the
 * suggestion is ignored. The suggestion never becomes the value by itself: an empty field shows it as a placeholder,
 * a value someone entered stays, and only accepting it reports `onSuggestionAccept` and then the normal
 * `onValueChange` and `onValueCommit`.
 */
export type FieldSuggestionProps<T> = {
  /** Passing the prop at all reserves the status line, also while it resolves to `undefined`. */
  suggestion?: MaybeAccessor<FieldSuggestion<T> | undefined>;
  onSuggestionAccept?: (id: string) => void;
};

/**
 * What a field shows for its suggestion:
 * `open` — an empty, untouched field shows the suggestion as its placeholder;
 * `differs` — the field holds someone's own value (or was deliberately emptied) and the suggestion only sits in the status line;
 * `matches` — the value equals the suggestion, entered by hand;
 * `accepted` — the value equals the suggestion and the owner marked it accepted.
 */
export type FieldSuggestionView = "none" | "loading" | "error" | "open" | "differs" | "matches" | "accepted";

/** What a field wires into its control. Without a `SuggestionGroup` around it, every part is empty or unchanged. */
export type FieldSuggestionControl<T> = {
  /** True when the field was given a `suggestion` prop inside a group; the status line is reserved from the first render. */
  enabled: boolean;
  view: () => FieldSuggestionView;
  /** The ready suggestion's value, also once accepted or overruled. */
  value: () => T | undefined;
  /** The suggestion's text while the field shows it in place of a value. */
  placeholder: () => string | undefined;
  /** The control's `aria-describedby` with the status line's description added. */
  describe: (describedBy: string | undefined) => string | undefined;
  /** The suggested position a switch names beside itself. */
  inline: () => string | undefined;
  /** The field's class with the suggestion marker and its state (open, unsure, loading) added. */
  field: (className: string | undefined) => string | undefined;
  /** The status line beside a visible label, for `Field`'s `labelEnd`. */
  status: JSX.Element;
  /** The control, followed by the status line when the field has no visible label. */
  under: (control: JSX.Element) => JSX.Element;
};

type SuggestionOwner<T> = FieldSuggestionProps<T> &
  Pick<FieldProps, "label" | "aria-label" | "disabled" | "error"> & {
    readOnly?: boolean;
    /** Bounds a number or a date key must keep to be offered. */
    min?: unknown;
    max?: unknown;
    onValueChange?: (value: T) => void;
    onValueCommit?: (value: T) => void;
  };

export type FieldSuggestionOptions<T> = {
  /** The field's props; disabled, read-only, error, and the value callbacks come from here unless overridden. */
  props: SuggestionOwner<T>;
  /** `false` turns suggestions off for a mode that cannot show them. */
  enabled?: boolean;
  meta: FieldMeta;
  value: () => T | null | undefined;
  /** Whether the field counts as empty; defaults to `null`, `undefined`, or `""`. */
  blank?: () => boolean;
  same?: (left: T, right: T) => boolean;
  /** How a value reads; strings read as they are, booleans as yes and no. */
  format?: (value: T) => string;
  /** Sets the value; defaults to the normal change and commit callbacks. `label` is how the suggestion named it. */
  apply?: (value: T, label: string | undefined) => void;
  /**
   * Whether the field would take this value as it is (step, enabled option); otherwise it offers no Accept. Values
   * outside the field's `min` and `max` are never offered.
   */
  acceptable?: (value: T) => boolean;
  /** The control does not speak its placeholder (a button or a switch), so the description names the value. */
  spokenValue?: boolean;
};

export type CreateFieldSuggestion = <T>(options: FieldSuggestionOptions<T>) => FieldSuggestionControl<T>;
