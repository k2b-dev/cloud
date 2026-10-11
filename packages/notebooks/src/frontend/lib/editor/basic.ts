import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, foldKeymap, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightSpecialChars,
  keymap,
  rectangularSelection,
} from "@codemirror/view";

/**
 * Slightly modified version of the basic extensions provided by CodeMirror.
 * @see https://github.com/codemirror/basic-setup/blob/main/src/codemirror.ts
 */
export const basicExtensions: () => Extension = () => [
  highlightSpecialChars(),
  drawSelection(),
  dropCursor(),
  EditorView.lineWrapping,
  EditorState.allowMultipleSelections.of(true),
  EditorState.tabSize.of(2),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  bracketMatching(),
  closeBrackets(),
  rectangularSelection(),
  crosshairCursor(),
  highlightSelectionMatches(),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap]),
];
