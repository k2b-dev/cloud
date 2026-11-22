import { type JSX, splitProps } from "solid-js";

/**
 * A file name split before its ending: `{ stem: "Report 2026", ext: ".pdf" }`. A name without a dot, a hidden file
 * such as `.env`, or a name that ends in a dot has no ending. A long ending (more than ten characters after the dot)
 * counts as part of the name, so a dotted title does not read as a file type.
 */
export const splitFileName = (name: string): { stem: string; ext: string } => {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1 || name.length - dot - 1 > 10) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
};

export type FileNameProps = Omit<JSX.HTMLAttributes<HTMLSpanElement>, "children"> & {
  /** The whole name, ending included. */
  name: string;
};

/**
 * A file name on one line that shortens before its ending (K15): `Quarterly rep….pdf`. The ending always stays, and
 * the whole name is the hint on hover and the text a screen reader reads.
 */
export function FileName(props: FileNameProps): JSX.Element {
  const [local, rest] = splitProps(props, ["name", "class"]);
  const parts = () => splitFileName(local.name);
  return (
    <span {...rest} class={local.class ? `k2b-file-name ${local.class}` : "k2b-file-name"} title={local.name}>
      <span class="k2b-file-name__stem">{parts().stem}</span>
      {parts().ext ? <span class="k2b-file-name__ext">{parts().ext}</span> : null}
    </span>
  );
}

export default FileName;
