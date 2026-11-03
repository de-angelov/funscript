import { Array, pipe } from "effect";

export const apply = (value) => pipe(
  value,
  Array.map((item) => (item + 1))
);
