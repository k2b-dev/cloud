import { For, Show } from "solid-js";
import { type PropRow, type PropsDoc, v2Props } from "./build-results";

const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
/** TSDoc text with its `code` spans, as HTML. */
const inlineCode = (text: string) => escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");

const Rows = (props: { rows: readonly PropRow[]; variant?: boolean }) => (
  <For each={props.rows}>
    {(row) => (
      <tr>
        <td>
          <code>{row.name}</code>
          <Show when={row.required}>
            <span class="ui-props__required">{props.variant ? "required in this variant" : "required"}</span>
          </Show>
        </td>
        <td>
          <code>{row.type}</code>
        </td>
        <td innerHTML={row.description ? inlineCode(row.description) : "–"} />
      </tr>
    )}
  </For>
);

/** One generated props table: shared props, then one group per variant ("With `rowKey`"). */
export const PropsTable = (props: { doc: PropsDoc }) => (
  <div class="ui-props">
    <div class="ui-props__head">
      <b>{props.doc.title}</b>
      <span>
        from the types in <code>{props.doc.file}</code>
      </span>
      <span class="ui-props__fill" />
      <span class="ui-props__chip">generated</span>
    </div>
    <div class="ui-props__scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Prop</th>
            <th scope="col">Type</th>
            <th scope="col">What it does</th>
          </tr>
        </thead>
        <tbody>
          <Rows rows={props.doc.rows} />
          <For each={props.doc.groups}>
            {(group) => (
              <>
                <tr class="ui-props__group">
                  <th scope="rowgroup" colSpan={3} innerHTML={inlineCode(group.title)} />
                </tr>
                <Rows rows={group.rows} variant />
              </>
            )}
          </For>
        </tbody>
      </table>
    </div>
  </div>
);

/**
 * Fibel's `Props`: the props of parts of `@k2b/ui/v2` (`Table`, `Pane.Split`) or of their object types (`Column`), read
 * from the types at build time; the description is the first sentence of each prop's TSDoc.
 */
export const Props = (props: { of: readonly string[] }) => (
  <div class="ui-props-list">
    <For each={props.of}>{(name) => <Show when={v2Props[name]}>{(doc) => <PropsTable doc={doc()} />}</Show>}</For>
  </div>
);
