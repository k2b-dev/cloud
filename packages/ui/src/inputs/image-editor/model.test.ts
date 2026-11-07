import { describe, expect, test } from "bun:test";
import { imageEditorMatrix, inverseEditorPoint, transformEditorPoint } from "./geometry";
import {
  commitImageEditorState,
  createImageEditorHistory,
  currentImageEditorEntry,
  editorOutputSize,
  imageEditorDirty,
  initialImageEditorState,
  markImageEditorSaved,
  redoImageEditor,
  rotateEditorRight,
  undoImageEditor,
} from "./model";

describe("shared image editor model", () => {
  test("saved identity survives undo but a new branch at the same index stays dirty", () => {
    let history = createImageEditorHistory();
    const base = currentImageEditorEntry(history).state;
    history = commitImageEditorState(history, { ...base, straighten: 10 });
    history = markImageEditorSaved(history);
    expect(imageEditorDirty(history)).toBe(false);
    history = commitImageEditorState(history, { ...base, straighten: 15 });
    expect(imageEditorDirty(history)).toBe(true);
    history = undoImageEditor(history);
    expect(imageEditorDirty(history)).toBe(false);
    history = undoImageEditor(history);
    history = commitImageEditorState(history, { ...base, straighten: 20 });
    expect(imageEditorDirty(history)).toBe(true);
    expect(redoImageEditor(history).index).toBe(history.index);
  });
  test("an awaited save marks only its captured entry, not later edits", () => {
    let history = createImageEditorHistory();
    const saved = currentImageEditorEntry(history);
    history = commitImageEditorState(history, { ...saved.state, flipX: true });
    history = markImageEditorSaved(history, saved);
    expect(imageEditorDirty(history)).toBe(true);
    expect(imageEditorDirty(undoImageEditor(history))).toBe(false);
  });
  test("preserves the existing undo budget across all edit kinds", () => {
    let history = createImageEditorHistory();
    for (let i = 0; i < 70; i++) history = commitImageEditorState(history, { ...currentImageEditorEntry(history).state, straighten: i });
    expect(history.entries.length).toBe(51);
    for (let i = 0; i < 60; i++) history = undoImageEditor(history);
    expect(currentImageEditorEntry(history).state.straighten).toBe(19);
    expect(imageEditorDirty(history)).toBe(true);
  });
  test("bounds output pixels while preserving aspect and crop", () => {
    const state = initialImageEditorState();
    const source = { width: 8000, height: 6000 };
    const bounded = editorOutputSize(source, state);
    expect(bounded.width * bounded.height).toBeLessThanOrEqual(16_700_000);
    expect(bounded.width / bounded.height).toBeCloseTo(4 / 3, 3);
    expect(bounded.downscaled).toBe(true);
    expect(editorOutputSize(source, state, "device")).toEqual({ ...source, downscaled: false });
    expect(editorOutputSize(source, state, 48, 400)).toEqual({ width: 400, height: 300, downscaled: true });
    expect(() => editorOutputSize(source, state, NaN)).toThrow();
    expect(() => editorOutputSize(source, state, 0)).toThrow();
    expect(() => editorOutputSize(source, state, "device", Infinity)).toThrow();
  });
  test("quarter turns preserve the selected source region", () => {
    const state = { ...initialImageEditorState(), crop: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } };
    const rotated = rotateEditorRight(state);
    expect(rotated.rotation).toBe(90);
    expect(rotated.crop.x).toBeCloseTo(0.4);
    expect(rotated.crop.y).toBeCloseTo(0.1);
    expect(rotated.crop.width).toBe(0.4);
    expect(rotated.crop.height).toBe(0.3);
  });
  test("pointer and annotation coordinates round-trip through every geometry operation", () => {
    const source = { width: 1600, height: 1067 };
    for (const rotation of [0, 90, 180, 270] as const) {
      const state = {
        ...initialImageEditorState(),
        rotation,
        straighten: 27,
        flipX: true,
        crop: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
      };
      const matrix = imageEditorMatrix(source, state, { width: 800, height: 600 });
      const point = { x: 1200, y: 600 };
      const restored = inverseEditorPoint(matrix, transformEditorPoint(matrix, point));
      expect(restored.x).toBeCloseTo(point.x, 9);
      expect(restored.y).toBeCloseTo(point.y, 9);
    }
  });
});
