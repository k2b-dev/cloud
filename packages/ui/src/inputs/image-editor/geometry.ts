import { rotatedEditorSize } from "./model";
import type { ImageEditorPoint, ImageEditorSourceSize, ImageEditorState } from "./types";

export type ImageEditorMatrix = { a: number; b: number; c: number; d: number; e: number; f: number };
const multiply = (left: ImageEditorMatrix, right: ImageEditorMatrix): ImageEditorMatrix => ({
  a: left.a * right.a + left.c * right.b,
  b: left.b * right.a + left.d * right.b,
  c: left.a * right.c + left.c * right.d,
  d: left.b * right.c + left.d * right.d,
  e: left.a * right.e + left.c * right.f + left.e,
  f: left.b * right.e + left.d * right.f + left.f,
});
const scale = (x: number, y: number): ImageEditorMatrix => ({ a: x, b: 0, c: 0, d: y, e: 0, f: 0 });
const translate = (x: number, y: number): ImageEditorMatrix => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });
const rotate = (angle: number): ImageEditorMatrix => ({
  a: Math.cos(angle),
  b: Math.sin(angle),
  c: -Math.sin(angle),
  d: Math.cos(angle),
  e: 0,
  f: 0,
});

/** One source-to-output transform for image pixels, annotations, and pointer coordinates. */
export const imageEditorMatrix = (
  source: ImageEditorSourceSize,
  state: ImageEditorState,
  output: { width: number; height: number },
): ImageEditorMatrix => {
  const size = rotatedEditorSize(source, state);
  const angle = (state.straighten * Math.PI) / 180;
  const zoom = Math.max(
    Math.abs(Math.cos(angle)) + (size.height / size.width) * Math.abs(Math.sin(angle)),
    Math.abs(Math.cos(angle)) + (size.width / size.height) * Math.abs(Math.sin(angle)),
  );
  const steps = [
    scale(output.width / (size.width * state.crop.width), output.height / (size.height * state.crop.height)),
    translate(-state.crop.x * size.width, -state.crop.y * size.height),
    translate(size.width / 2, size.height / 2),
    rotate(angle),
    scale(zoom, zoom),
    scale(state.flipX ? -1 : 1, state.flipY ? -1 : 1),
    rotate((state.rotation * Math.PI) / 180),
    translate(-source.width / 2, -source.height / 2),
  ];
  return steps.reduce(multiply);
};
export const transformEditorPoint = (matrix: ImageEditorMatrix, point: ImageEditorPoint): ImageEditorPoint => ({
  x: matrix.a * point.x + matrix.c * point.y + matrix.e,
  y: matrix.b * point.x + matrix.d * point.y + matrix.f,
});
export const inverseEditorPoint = (matrix: ImageEditorMatrix, point: ImageEditorPoint): ImageEditorPoint => {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (Math.abs(determinant) < Number.EPSILON) throw new Error("Image editor transform is not invertible");
  const x = point.x - matrix.e;
  const y = point.y - matrix.f;
  return { x: (matrix.d * x - matrix.c * y) / determinant, y: (-matrix.b * x + matrix.a * y) / determinant };
};
