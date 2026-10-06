// A comment may say `export const x = 1`.
export type { Quote } from "./quote.ts";
export const VERSION = 1;
export function parse(): void {}
export { VERSION as RENAMED, type Quote as Q };
export * from "./quote.ts";
export {
  type Quote as SameQuote,
  type Side as SameSide,
} from "./quote.ts";
export enum Level {
  Top,
}
export class Box {}
export default VERSION;
import type { Quote } from "./quote.ts";
