// A types-only package may say `export const x = 1` in a comment.
/* export function inABlockComment(): void {} */
export type { Quote } from "./quote.ts";
export type * from "./quote.ts";
export { type Quote as PricedQuote } from "./quote.ts";
export {
  type Quote as SameQuote,
  type Side as SameSide,
} from "./quote.ts";

export interface Named {
  name: string;
}

export type Level = "top" | "deep";

export declare namespace Shapes {
  type Point = [number, number];
}

export {};
