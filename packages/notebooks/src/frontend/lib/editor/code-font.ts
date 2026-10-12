/**
 * Per-node mono font for fenced and inline code in the markdown editor.
 *
 * The editor body uses Sans (matches read-mode + the rest of the platform)
 * but code should stay monospace — tabular alignment, escaped characters,
 * indentation all rely on equal-width glyphs.
 *
 * This extension walks the markdown syntax tree and adds a `cm-md-code`
 * class to every FencedCode / InlineCode / CodeBlock node, plus
 * `cm-md-code-block` on blocks. The theme styles them with `var(--font-mono)`
 * at the Book's code sizes.
 *
 * Only registered in rich mode — raw mode renders the entire document as
 * mono via the theme directly (it's a source view).
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { RangeSet, StateField } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { Decoration, EditorView } from "@codemirror/view";
import { refreshMarkdownDecorationsEffect, treeOrDocChanged } from "./_lib/cursor-zone-field";

const codeMark = Decoration.mark({ class: "cm-md-code" });
const blockCodeMark = Decoration.mark({ class: "cm-md-code cm-md-code-block" });

const buildCodeFontDecorations = (state: EditorState): Range<Decoration>[] => {
  const decorations: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      const { name, from, to } = node;
      if (to <= from) return;
      if (name === "InlineCode") decorations.push(codeMark.range(from, to));
      else if (name === "FencedCode" || name === "CodeBlock") decorations.push(blockCodeMark.range(from, to));
    },
  });
  return decorations;
};

export const codeFontExtension = (): Extension => {
  return StateField.define<DecorationSet>({
    create(state) {
      return RangeSet.of(buildCodeFontDecorations(state), true);
    },
    update(decorations, tr) {
      if (treeOrDocChanged(tr) || tr.effects.some((effect) => effect.is(refreshMarkdownDecorationsEffect))) {
        return RangeSet.of(buildCodeFontDecorations(tr.state), true);
      }
      return decorations;
    },
    provide(field) {
      return EditorView.decorations.from(field);
    },
  });
};
