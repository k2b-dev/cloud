import { useLocale } from "@k2b/ui";
import { Avatar, Inline, type Person, Text } from "@k2b/ui/v2";
import { Show } from "solid-js";
import { type AccessSummaryProps, createAccessSummary } from "./access-summary";
import { principalFace } from "./principal-face";
import { principalLabel } from "./principal-label";

/** Faces before "+n", as in v1. */
const FACES = 5;

/**
 * Who has access to a resource on v2: the members as one stack of faces with "+n", and the one line beside it (members,
 * signed-in people, visitors, Code's accounts). The same data as `AccessSummary`; it stands where a v2 page shows a
 * value, such as the end of a settings row beside the button that opens the access dialog.
 */
export function AccessSummaryV2(props: AccessSummaryProps) {
  const locale = useLocale();
  const summary = createAccessSummary(props, locale);
  const people = (): Person[] =>
    summary.members().map((entry) => {
      const name = principalLabel(entry, locale());
      const face = principalFace(entry.principal, name, entry);
      // A thing in a stack of people shows its initials in its kind's colour.
      return "avatar" in face ? face.avatar : { name, color: face.mark.color };
    });
  return (
    <Inline>
      <Show when={people().length > 0}>
        <Avatar.Stack
          people={people()}
          max={FACES}
          label={summary.t().summaryStackLabel({ name: people()[0]!.name, more: people().length - 1 })}
        />
      </Show>
      <Text type="meta">{summary.line()}</Text>
    </Inline>
  );
}
