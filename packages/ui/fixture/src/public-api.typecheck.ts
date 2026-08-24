import type {
  ContextMenuProps,
  CopyButtonValue,
  DateContext,
  DatePickerBaseProps,
  DropdownActionBase,
  FormatCurrencyProps,
  FormatDateProps,
  FormatRelativeTimeProps,
  LocaleProviderProps,
  MaybeAccessor,
  NumberInputProps,
  PromptFieldBase,
  SelectSourceOption,
} from "@k2b/ui";
import {
  Button,
  Checkbox,
  CheckboxCard,
  Format,
  IconButton,
  LocaleProvider,
  MultiSelectInput,
  RemoveButton,
  Select,
  Switch,
  useLocale,
} from "@k2b/ui";

const components = [Button, Checkbox, CheckboxCard, IconButton, MultiSelectInput, RemoveButton, Select, Switch];
const dateContext: DateContext = { locale: "en", timeZone: "UTC" };
const dateProps: DatePickerBaseProps<string | null> = { value: null, dateConfig: dateContext };
const maybe: MaybeAccessor<string> = () => "ready";
const selectOption: SelectSourceOption = { id: "platform", label: "Platform" };
const contextMenu: ContextMenuProps["items"] = [{ label: "Open", action: () => undefined }];
const copyValue: CopyButtonValue = { text: "portable" };
const dropdownAction: DropdownActionBase = { label: "Open" };
const promptField: PromptFieldBase<string> = { label: "Name" };

const intlComponents = [Format.Number, Format.Currency, Format.Date, Format.RelativeTime, LocaleProvider, useLocale];
const localeProviderProps: LocaleProviderProps = { locale: "de" };
const formatCurrencyProps: FormatCurrencyProps = { value: 19.5, currency: "EUR", decimals: 2 };
const formatDateProps: FormatDateProps = { value: new Date(), timeZone: "Europe/Berlin", locale: "de" };
const formatRelativeProps: FormatRelativeTimeProps = { value: "2026-07-28T09:00:00Z", base: new Date(0) };
const numberInputProps: NumberInputProps = { value: 1.5, locale: "de", increaseLabel: "Mehr", decreaseLabel: "Weniger" };

void [
  components,
  contextMenu,
  copyValue,
  dateProps,
  dropdownAction,
  formatCurrencyProps,
  formatDateProps,
  formatRelativeProps,
  intlComponents,
  localeProviderProps,
  maybe,
  numberInputProps,
  promptField,
  selectOption,
];

// Cloud compatibility names are deliberately absent from the package API.
// @ts-expect-error no compatibility alias
import type { CheckboxInput } from "@k2b/ui";
// @ts-expect-error no compatibility alias
import type { CheckboxCardInput } from "@k2b/ui";
// @ts-expect-error no compatibility alias
import type { MultiSelect } from "@k2b/ui";
// @ts-expect-error no compatibility alias
import type { RemoveBtn } from "@k2b/ui";
// @ts-expect-error no compatibility alias
import type { RemoveBtnProps } from "@k2b/ui";
// @ts-expect-error no compatibility alias
import type { SegmentedControlOption } from "@k2b/ui";
// @ts-expect-error obsolete callback wrapper; use onValueChange directly
import type { FilterChipChange } from "@k2b/ui";
// @ts-expect-error obsolete callback wrapper; use onValueChange directly
import type { SegmentedControlChange } from "@k2b/ui";
// @ts-expect-error no compatibility alias
import type { SelectInput } from "@k2b/ui";
// @ts-expect-error no compatibility alias
import type { SwitchInput } from "@k2b/ui";
