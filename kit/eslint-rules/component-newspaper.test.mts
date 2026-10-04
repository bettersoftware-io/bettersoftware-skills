import { RuleTester } from "@typescript-eslint/rule-tester";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";

import { componentNewspaper } from "./component-newspaper.mts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2023,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run("component-newspaper", componentNewspaper, {
  valid: [
    {
      name: "single exported component as lede, private subcomponent below",
      filename: "AdminDashboard.tsx",
      code: "export function AdminDashboard() {\n  return <div />;\n}\n\nfunction Card() {\n  return <div />;\n}\n",
    },
    {
      name: "lone component matching filename",
      filename: "App.tsx",
      code: "export function App() {\n  return <div />;\n}\n",
    },
    {
      name: "helper const below the exported component is fine (render-deferred ref)",
      filename: "Heatmap.tsx",
      code: "export function Heatmap() {\n  return <div>{SECTOR_MAP.a}</div>;\n}\n\nconst SECTOR_MAP = { a: 1 };\n",
    },
    {
      name: "memo-wrapped exported component as lede",
      filename: "Tile.tsx",
      code: 'import { memo } from "react";\n\nexport const Tile = memo(function Tile() {\n  return <div />;\n});\n\nfunction Inner() {\n  return <span />;\n}\n',
    },
    {
      name: "useX hook is not a component (camelCase) and is ignored",
      filename: "Widget.tsx",
      code: "export function Widget() {\n  return <div />;\n}\n\nfunction useThing() {\n  return 1;\n}\n",
    },
    {
      name: "file with no component is never flagged",
      filename: "helpers.tsx",
      code: "export const x = 1;\n\nexport function helper() {\n  return 1;\n}\n",
    },
  ],
  invalid: [
    {
      name: "private component above the export is reordered to the lede",
      filename: "AdminDashboard.tsx",
      code: "function Card() {\n  return <div />;\n}\n\nexport function AdminDashboard() {\n  return <div />;\n}\n",
      errors: [{ messageId: "notLede", data: { name: "AdminDashboard" } }],
      output:
        "export function AdminDashboard() {\n  return <div />;\n}\n\nfunction Card() {\n  return <div />;\n}\n\n\n",
    },
    {
      name: "non-component const above the export is reordered below it",
      filename: "Heatmap.tsx",
      code: "const SECTOR_MAP = { a: 1 };\n\nexport function Heatmap() {\n  return <div />;\n}\n",
      errors: [{ messageId: "notLede", data: { name: "Heatmap" } }],
      output:
        "export function Heatmap() {\n  return <div />;\n}\n\nconst SECTOR_MAP = { a: 1 };\n\n\n",
    },
    {
      name: "type/interface above the export is reordered below it",
      filename: "Widget.tsx",
      code: "interface Props {\n  x: number;\n}\n\nexport function Widget({ x }: Props) {\n  return <div>{x}</div>;\n}\n",
      errors: [{ messageId: "notLede", data: { name: "Widget" } }],
      output:
        "export function Widget({ x }: Props) {\n  return <div>{x}</div>;\n}\n\ninterface Props {\n  x: number;\n}\n\n\n",
    },
    {
      name: "leading comment on private subcomponent above the export is preserved after autofix",
      filename: "AdminDashboard.tsx",
      code: "// keep me\nfunction Card() {\n  return <div />;\n}\n\nexport function AdminDashboard() {\n  return <div />;\n}\n",
      errors: [{ messageId: "notLede", data: { name: "AdminDashboard" } }],
      output:
        "export function AdminDashboard() {\n  return <div />;\n}\n\n// keep me\nfunction Card() {\n  return <div />;\n}\n\n\n",
    },
    {
      name: "two exported components: report the second, no autofix",
      filename: "TilePrice.tsx",
      code: "export function TilePrice() {\n  return <div />;\n}\n\nexport function SpreadDisplay() {\n  return <div />;\n}\n",
      errors: [
        { messageId: "multipleExports", data: { name: "SpreadDisplay" } },
      ],
      output: null,
    },
    {
      name: "filename mismatch on the single exported component, no autofix",
      filename: "Foo.tsx",
      code: "export function Bar() {\n  return <div />;\n}\n",
      errors: [
        { messageId: "filenameMismatch", data: { name: "Bar", base: "Foo" } },
      ],
      output: null,
    },
  ],
});
