/**
 * `@k2b/ui/v2`: the second generation of `@k2b/ui`, built beside v1.
 *
 * **Provisional until the maintainer approves v2.** Names, props and styles may change in any release until then;
 * no application ships a v2 screen before its screen is approved against the mockup.
 *
 * - Styles: `@k2b/ui/v2.css`, everything below the root class `k2-ui`, in the `k2-` namespace beside v1's `k2b-`.
 * - Primitives own spacing, lines and type. They take no `class`, `style`, `size` or `gap`; free drawing belongs in
 *   `Canvas` only. The repository checks `v2-primitive-props`, `v2-app-layout-css` and `v2-no-ui-sdk-outside-ui`
 *   enforce this.
 */

// The page's language, as in the rest of @k2b/ui, without the v1 entry: a v2 island imports it from here.
export { useLocale } from "../intl/locale";
// The bare address of a display form such as `"Berg, Anna" <anna@example.org>`, as an address field reads it.
export { addressOf } from "./addresses";
// News for assistive technology that the page shows nowhere as it happens (a run that changed its state).
export { announce } from "./announce";
export { Button, type ButtonProps } from "./button";
export { CodeInput, type CodeInputProps } from "./code-input";
export { ColorInput, type ColorInputProps } from "./color-input";
// Layer 2: components made of the primitives.
export {
  Digest,
  type DigestEntry,
  type DigestProps,
  Nav,
  type NavGroup,
  type NavItem,
  type NavProps,
  type NavSearch,
  Notice,
  type NoticeProps,
  Path,
  type PathProps,
  RecordHead,
  type RecordHeadProps,
  type RecordId,
  type StatusFact,
  StatusRow,
  type StatusRowProps,
  type Step,
  Steps,
  type StepsProps,
  type Tab,
  Tabs,
  type TabsProps,
} from "./components";
export {
  type CellValue,
  type Column,
  type Fact,
  Facts,
  type FactsProps,
  Inline,
  type InlineProps,
  List,
  type ListProps,
  type OpenTarget,
  Row,
  type RowLines,
  type RowProps,
  Table,
  type TableGroup,
  type TableProps,
  type TableTree,
  Text,
  type TextProps,
} from "./content";
// The form controls. A control with behaviour of its own has a module of its own, so a page that uses it only in a
// lazy part keeps that behaviour out of its first chunk (lazy-chunks.bundle.test.ts).
export {
  Check,
  type CheckProps,
  Choice,
  type ChoiceOption,
  type ChoiceProps,
  Field,
  type FieldProps,
  Input,
  type InputProps,
  type InputSend,
} from "./controls";
export { DateInput, type DateInputProps } from "./date-input";
// A month of days to pick one from (with a time for points in time); DateInput opens it.
export { DatePicker, type DatePickerProps } from "./date-picker";
export { type DescribeV2Options, describeV2 } from "./describe";
export { Disclosure, type DisclosureProps } from "./disclosure";
// the error fallback of every island: a module of its own, which loads no other part
export { Failed, type FailedProps } from "./failed";
// Lists people filter, sort and group: the statements of a `defineListQuery` declaration, and values that load.
export { FilterBar, type FilterBarProps, type FilterBarViews, ListOrder, type ListOrderProps, viewIcon } from "./filter-bar";
export { Group, type GroupProps } from "./group";
// A year of days as a picture: what happened per day, in tones of one colour.
export { Heat, type HeatDay, type HeatProps } from "./heat";
export { ImageInput, type ImageInputProps } from "./image-input";
// Layer 1: the primitives.
export {
  Band,
  type BandProps,
  Bar,
  type BarProps,
  Canvas,
  type CanvasProps,
  type CellProps,
  Cells,
  Pane,
  type PaneProps,
  type Tile,
  Tiles,
  type TilesProps,
  Workspace,
  type WorkspaceProps,
} from "./layout";
export { Lookup, type LookupLoad, type LookupProps, type LookupResolve } from "./lookup";
export {
  Avatar,
  type AvatarProps,
  Chip,
  type ChipProps,
  Icon,
  type IconProps,
  Progress,
  type ProgressProps,
  type TickState,
  Ticks,
  type TicksProps,
} from "./marks";
// Overlays: a menu, a popover (panel or tip) and toasts; their behaviour comes from the behaviour layer.
export { Menu, type MenuContextProps, type MenuEntry, type MenuItem, type MenuProps, type MenuSection, type TriggerProps } from "./menu";
export type { NavTree, NavTreeNode } from "./nav-tree";
// The overlays: v2 shapes on the behaviour layer.
export { type ConfirmOptions, confirm, Dialog, type DialogProps } from "./overlays";
export { Popover, type PopoverPanelProps, type PopoverProps, type PopoverTipProps } from "./popover";
export { Prose, type ProseProps } from "./prose";
export { Select, type SelectOption, type SelectProps } from "./select";
export { Slider, type SliderProps } from "./slider";
export { Empty, type EmptyProps, Loading, type LoadingProps } from "./states";
export { Section, type SectionProps } from "./structure";
export { TagsInput, type TagsInputProps } from "./tags-input";
export { type ShowToast, type ToastOptions, useToast } from "./toast";
export { fontWeights, gripTolerance, hairline, heights, radii, type TypeRole, textEdge, typeRoles } from "./tokens";
export type { Action, OnNavigate, Person, Status, TwoActions, Width } from "./types";
