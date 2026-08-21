import type {
  AutocompleteEditorProps,
  AutocompleteSelectProps,
  CheckboxCardProps,
  CheckboxProps,
  ColorInputProps,
  ComboboxProps,
  DatePickerProps,
  DateRangePickerProps,
  DateTimePickerProps,
  FieldProps,
  FileDropzoneProps,
  IconInputProps,
  ImageInputProps,
  MarkdownEditorProps,
  MultiSelectInputProps,
  NumberInputProps,
  PinInputProps,
  SelectProps,
  SelectChipProps,
  SliderProps,
  SwitchProps,
  TagsInputProps,
  TemplateEditorProps,
  TextInputProps,
  ValueFieldProps,
} from "./index";

type Expect<T extends true> = T;
type Extends<Actual, Contract> = Actual extends Contract ? true : false;

type ValueFieldContractCoverage = [
  Expect<Extends<TextInputProps, ValueFieldProps<string>>>,
  Expect<Extends<NumberInputProps, ValueFieldProps<number | null>>>,
  Expect<Extends<CheckboxProps, ValueFieldProps<boolean>>>,
  Expect<Extends<CheckboxCardProps, ValueFieldProps<boolean>>>,
  Expect<Extends<SwitchProps, ValueFieldProps<boolean>>>,
  Expect<Extends<SelectProps, ValueFieldProps<string | null>>>,
  Expect<Extends<MultiSelectInputProps, ValueFieldProps<string[]>>>,
  Expect<Extends<TagsInputProps, ValueFieldProps<string[]>>>,
  Expect<Extends<PinInputProps, ValueFieldProps<string>>>,
  Expect<Extends<SliderProps, ValueFieldProps<number>>>,
  Expect<Extends<ColorInputProps, ValueFieldProps<string>>>,
  Expect<Extends<DatePickerProps, ValueFieldProps<string | null>>>,
  Expect<Extends<DateTimePickerProps, ValueFieldProps<string | null>>>,
  Expect<Extends<DateRangePickerProps, ValueFieldProps<{ start: string | null; end: string | null }>>>,
  Expect<Extends<SelectChipProps<string>, ValueFieldProps<string>>>,
  Expect<Extends<AutocompleteEditorProps, ValueFieldProps<string>>>,
  Expect<Extends<AutocompleteSelectProps, ValueFieldProps<string | null>>>,
  Expect<Extends<MarkdownEditorProps, ValueFieldProps<string>>>,
  Expect<Extends<TemplateEditorProps, ValueFieldProps<string>>>,
  Expect<Extends<ImageInputProps, ValueFieldProps<string | null>>>,
  Expect<Extends<IconInputProps, ValueFieldProps<string | null>>>,
];

type FieldContractCoverage = [Expect<Extends<ComboboxProps, FieldProps>>, Expect<Extends<FileDropzoneProps, FieldProps>>];

const text: TextInputProps = { label: "Name", value: "", onValueChange: () => {}, onValueCommit: () => {} };
const number: NumberInputProps = { label: "Count", value: null, onValueChange: () => {}, onValueCommit: () => {} };
const select: SelectProps = { label: "Team", value: null, onValueChange: () => {}, options: [] };
const autocompleteSelect: AutocompleteSelectProps = { label: "Team", value: null, search: async () => ({ options: [] }) };
const multi: MultiSelectInputProps = { label: "Teams", value: [], onValueChange: () => {}, options: [] };
const tags: TagsInputProps = { "aria-label": "Tags", value: [], onValueChange: () => {} };
const color: ColorInputProps = {
  label: "Color",
  value: "#fff",
  onValueChange: () => {},
  transparentValue: false,
  onTransparentValueChange: () => {},
};
const image: ImageInputProps = { label: "Image", value: null, onValueChange: () => {} };
const date: DatePickerProps = { label: "Date", value: () => null, onValueChange: () => {}, onValueCommit: () => {} };

// @ts-expect-error Legacy field callbacks are intentionally unsupported.
const legacyText: TextInputProps = { label: "Name", onInput: () => {} };
// @ts-expect-error Legacy commit callbacks are intentionally unsupported.
const legacyNumber: NumberInputProps = { label: "Count", onChange: () => {} };
// @ts-expect-error Select has one canonical value callback.
const legacySelect: SelectProps = { label: "Team", onChange: () => {}, options: [] };
// @ts-expect-error Multi-select uses value, not values.
const legacyMultiValue: MultiSelectInputProps = { label: "Teams", values: [], options: [] };
// @ts-expect-error Multi-select has one canonical value callback.
const legacyMultiCallback: MultiSelectInputProps = { label: "Teams", onValuesChange: () => {}, options: [] };
// @ts-expect-error Tags has one canonical value callback.
const legacyTags: TagsInputProps = { label: "Tags", onChange: () => {} };
// @ts-expect-error Native ARIA attribute names are used everywhere.
const legacyImageLabel: ImageInputProps = { label: "Image", ariaLabel: "Image", onValueChange: () => {} };
// @ts-expect-error Secondary controlled values use the same value naming.
const legacyTransparent: ColorInputProps = { label: "Color", isTransparent: () => false };

void [text, number, select, autocompleteSelect, multi, tags, color, image, date];
void (0 as unknown as ValueFieldContractCoverage);
void (0 as unknown as FieldContractCoverage);
