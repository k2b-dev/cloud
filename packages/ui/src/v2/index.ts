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
  RecordHead,
  type RecordHeadProps,
  type RecordId,
  type StatusFact,
  StatusRow,
  type StatusRowProps,
  type Step,
  Steps,
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
  Prose,
  type ProseProps,
  Row,
  type RowLines,
  type RowProps,
  Table,
  type TableProps,
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
  type SelectProps,
} from "./controls";
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
  Workspace,
  type WorkspaceProps,
} from "./layout";
export { Avatar, type AvatarProps, Chip, type ChipProps, Icon, type IconProps, Progress, type ProgressProps } from "./marks";
export { Group, type GroupProps, Section, type SectionProps } from "./structure";
export { fontWeights, gripTolerance, hairline, heights, radii, type TypeRole, textEdge, typeRoles } from "./tokens";
export type { Action, Person, Status, Width } from "./types";
