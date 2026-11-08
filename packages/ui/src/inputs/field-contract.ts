import type { DateContext as StdlibDateContext } from "@k2b/stdlib";
import type { JSX } from "solid-js";

export type DateContext = StdlibDateContext;
export type MaybeAccessor<T> = T | (() => T);

export type FieldProps = {
  id?: string;
  class?: string;
  label?: JSX.Element;
  description?: JSX.Element;
  error?: MaybeAccessor<JSX.Element | undefined>;
  required?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
};

export type ValueFieldProps<T> = FieldProps & {
  value: MaybeAccessor<T>;
  onValueChange?: (value: T) => void;
  onValueCommit?: (value: T) => void;
};

export type { FieldSuggestion, FieldSuggestionProps } from "./field-suggestion-types";

/** Reports one atomic edit as both the current and committed field value. */
export const commitFieldValue = <T>(owner: Pick<ValueFieldProps<T>, "onValueChange" | "onValueCommit">, value: T): void => {
  owner.onValueChange?.(value);
  owner.onValueCommit?.(value);
};

export function resolveMaybeAccessor<T>(value: MaybeAccessor<T>): T;
export function resolveMaybeAccessor<T>(value: MaybeAccessor<T> | undefined): T | undefined;
export function resolveMaybeAccessor<T>(value: MaybeAccessor<T> | undefined): T | undefined {
  return typeof value === "function" ? (value as () => T)() : value;
}
