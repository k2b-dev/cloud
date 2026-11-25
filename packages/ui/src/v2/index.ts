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

export { Button, type ButtonProps } from "./button";
// Layer 2: components made of the primitives.
export {
  Digest,
  type DigestEntry,
  type DigestProps,
  Nav,
  type NavGroup,
  type NavItem,
  type NavProps,
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
  Prose,
  type ProseProps,
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
export {
  Check,
  type CheckProps,
  Choice,
  type ChoiceProps,
  DateInput,
  type DateInputProps,
  Field,
  type FieldProps,
  Input,
  type InputProps,
  Select,
  type SelectOption,
  type SelectProps,
} from "./controls";
export { type DescribeV2Options, describeV2 } from "./describe";
export type { DragMove } from "./drag";
// Lists people filter, sort and group: the statements of a `defineListQuery` declaration, and values that load.
export { FilterBar, type FilterBarProps, type FilterBarViews, ListOrder, type ListOrderProps, viewIcon } from "./filter-bar";
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
export { Avatar, type AvatarProps, Chip, type ChipProps, Icon, type IconProps, Progress, type ProgressProps } from "./marks";
// Overlays: a menu, a popover (panel or tip) and toasts; their behaviour comes from the behaviour layer.
export { Menu, type MenuContextProps, type MenuEntry, type MenuItem, type MenuProps, type MenuSection, type TriggerProps } from "./menu";
export type { NavTree, NavTreeNode } from "./nav-tree";
// The overlays: v2 shapes on the behaviour layer.
export { type ConfirmOptions, confirm, Dialog, type DialogProps } from "./overlays";
export type { PictureTile, PictureTilesProps } from "./picture-tiles";
export { Popover, type PopoverPanelProps, type PopoverProps, type PopoverTipProps } from "./popover";
export { Empty, type EmptyProps, Failed, type FailedProps, Loading, type LoadingProps } from "./states";
export { Group, type GroupProps, Section, type SectionProps } from "./structure";
export { type ShowToast, type ToastOptions, useToast } from "./toast";
export { fontWeights, gripTolerance, hairline, heights, radii, type TypeRole, textEdge, typeRoles } from "./tokens";
export type { Action, OnNavigate, Person, Status, TwoActions, Width } from "./types";
