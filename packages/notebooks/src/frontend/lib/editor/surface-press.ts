/**
 * Whether a press on the note's surface missed the editor, so the surface puts the caret at the end of the note.
 *
 * A press the editor already handled did not miss it, even when handling it replaced the pressed element: ticking a
 * checklist box redraws the box, so by the time the press reaches the surface its target is no longer inside the
 * editor. Treating that press as a miss would move the caret to the end and scroll the note there.
 */
export const pressMissedEditor = (event: MouseEvent): boolean =>
  !event.defaultPrevented && !(event.target instanceof Element && event.target.closest(".cm-editor"));
