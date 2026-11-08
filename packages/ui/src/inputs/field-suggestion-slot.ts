import { createContext, useContext } from "solid-js";
import type { CreateFieldSuggestion, FieldSuggestionControl, FieldSuggestionOptions } from "./field-suggestion-types";

// SuggestionGroup provides the suggestion code; fields hold only this slot, so forms without suggestions load none of it.
export const FieldSuggestionContext = createContext<CreateFieldSuggestion>();

const none = () => undefined;
const inert: FieldSuggestionControl<never> = {
  enabled: false,
  view: () => "none",
  value: none,
  placeholder: none,
  state: none,
  describedBy: none,
  edited: none,
  inline: none,
};

let warned = false;

export function useFieldSuggestion<T>(options: FieldSuggestionOptions<T>): FieldSuggestionControl<T> {
  const create = useContext(FieldSuggestionContext);
  if (options.enabled && !create && !warned) {
    warned = true;
    console.warn("@k2b/ui: a suggestion needs a SuggestionGroup");
  }
  return options.enabled && create ? create(options) : inert;
}
