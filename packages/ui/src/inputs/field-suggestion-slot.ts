import { createContext, useContext } from "solid-js";
import type { CreateFieldSuggestion, FieldSuggestionControl, FieldSuggestionOptions } from "./field-suggestion-types";

// SuggestionGroup provides the suggestion code; fields hold only this slot, so forms without suggestions load none of it.
export const FieldSuggestionContext = createContext<CreateFieldSuggestion>();

const none = () => undefined;
const same = <T>(value: T) => value;
const inert: FieldSuggestionControl<never> = {
  enabled: false,
  view: () => "none",
  value: none,
  placeholder: none,
  describe: same,
  inline: none,
  field: same,
  status: undefined,
  under: same,
};

export function useFieldSuggestion<T>(options: FieldSuggestionOptions<T>): FieldSuggestionControl<T> {
  const create = useContext(FieldSuggestionContext);
  return create && options.enabled !== false && "suggestion" in options.props ? create(options) : inert;
}
