import { Data } from "effect";

export type Shape = Data.TaggedEnum<{
  Circle: { readonly radius: number };
  Rect: { readonly width: number; readonly height: number }
}>;
const $Shape = Data.taggedEnum<Shape>();
export const Circle = (radius: number): Shape => $Shape.Circle({ radius });
export const Rect = (width: number, height: number): Shape => $Shape.Rect({ width, height });
