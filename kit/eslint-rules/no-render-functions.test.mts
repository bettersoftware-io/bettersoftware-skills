import { RuleTester } from "@typescript-eslint/rule-tester";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";

import { noRenderFunctions } from "./no-render-functions.mts";

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

ruleTester.run("no-render-functions", noRenderFunctions, {
  valid: [
    {
      name: "a component returning JSX is not a render function",
      code: "export function NavTab() {\n  return <button />;\n}\n",
    },
    {
      name: "RTL-style helper returning a render(...) CALL is legal (JSX only in arguments)",
      code: "export function renderWithTheme(ui) {\n  return render(<Provider>{ui}</Provider>);\n}\n",
    },
    {
      name: "anonymous arrow in render-prop position is legal",
      code: "const list = <FlatList renderItem={({ item }) => {\n  return <Row item={item} />;\n}} />;\n",
    },
    {
      name: "render* function returning a plain value",
      code: "function renderCount(rows) {\n  return rows.length;\n}\n",
    },
    {
      name: "render* function whose nested callback returns JSX, but which itself returns a call",
      code: "function renderAll(defs) {\n  return defs.map((d) => {\n    return <Row key={d.key} />;\n  });\n}\n",
    },
    {
      name: "non-render-named helper returning JSX is out of scope for this rule",
      code: "function tabFor(tab) {\n  return <button>{tab}</button>;\n}\n",
    },
  ],
  invalid: [
    {
      name: "function declaration render helper returning JSX",
      code: "function renderTab(tab) {\n  return <button>{tab}</button>;\n}\n",
      errors: [{ messageId: "renderFunction", data: { name: "renderTab" } }],
    },
    {
      name: "arrow const render helper returning JSX",
      code: "const renderRow = (row) => {\n  return <tr>{row}</tr>;\n};\n",
      errors: [{ messageId: "renderFunction", data: { name: "renderRow" } }],
    },
    {
      name: "expression-bodied arrow render helper",
      code: "const renderIcon = () => <Icon />;\n",
      errors: [{ messageId: "renderFunction", data: { name: "renderIcon" } }],
    },
    {
      name: "conditional JSX return still counts as JSX",
      code: "function renderBody(stage) {\n  return stage === 'busy' ? <Busy /> : null;\n}\n",
      errors: [{ messageId: "renderFunction", data: { name: "renderBody" } }],
    },
    {
      name: "switch dispatcher with JSX returns",
      code: "function renderNode(node) {\n  switch (node.kind) {\n    case 'panel':\n      return <Panel />;\n    default:\n      return null;\n  }\n}\n",
      errors: [{ messageId: "renderFunction", data: { name: "renderNode" } }],
    },
    {
      name: "object property render function",
      code: "const props = {\n  renderItem: ({ item }) => {\n    return <Row item={item} />;\n  },\n};\n",
      errors: [{ messageId: "renderFunction", data: { name: "renderItem" } }],
    },
    {
      name: "class method render helper",
      code: "class Legacy {\n  renderHeader() {\n    return <header />;\n  }\n}\n",
      errors: [{ messageId: "renderFunction", data: { name: "renderHeader" } }],
    },
  ],
});
