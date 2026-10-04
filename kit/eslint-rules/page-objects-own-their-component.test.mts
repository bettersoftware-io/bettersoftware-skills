import { RuleTester } from "@typescript-eslint/rule-tester";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";

import { pageObjectsOwnTheirComponent } from "./page-objects-own-their-component.mts";

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

ruleTester.run(
  "page-objects-own-their-component",
  pageObjectsOwnTheirComponent,
  {
    valid: [
      {
        name: "a function-typed param returning DATA is not a render function",
        code: "export interface P {\n  seed(read: () => Snapshot): void;\n}\n",
      },
      {
        name: "a `children` render function stays composition, not the subject",
        code: "export interface P {\n  wrap(children: () => JSX.Element): void;\n}\n",
      },
      {
        name: "an element as a GENERIC ARGUMENT of the parameter's type is not the parameter",
        code: "export interface P {\n  seed(cache: Map<string, ReactElement>): void;\n}\n",
      },
      {
        name: "an element as a generic CONSTRAINT on the method is not a parameter",
        code: "export interface P {\n  seed<T extends ReactElement>(key: string): void;\n}\n",
      },
      {
        name: "the sanctioned shape — the contract takes a props object",
        code: "export interface P {\n  mount(props: MountProps): void;\n}\n",
      },
      {
        name: "a `children` parameter is composition, not handing over the subject",
        code: "export interface P {\n  wrap(children: ReactElement): void;\n}\n",
      },
      {
        name: "ReactNode is the conventional children type and stays legal",
        code: "export interface P {\n  wrap(slot: ReactNode): void;\n}\n",
      },
      {
        name: "a RETURN type of ReactElement is the page BUILDING an element — exactly right",
        code: "export interface P {\n  engineOf(props: MountProps): ReactElement;\n}\n",
      },
      {
        name: "internal plumbing may hold an element — only the contract is checked",
        code: "let doRerender: ((element: ReactElement) => void) | null = null;\n",
      },
      {
        name: "a BARE Element is the DOM interface, not JSX.Element — a page measuring a node it was handed",
        code: "export interface P {\n  measure(el: Element): void;\n}\n",
      },
      {
        name: "an HTMLElement parameter is likewise a DOM node, not a subject",
        code: "export interface P {\n  measure(el: HTMLElement): void;\n}\n",
      },
      {
        name: "a non-interface function parameter is plumbing, not a contract",
        code: "function render(element: ReactElement): void {}\n",
      },
    ],
    invalid: [
      {
        name: "a RENDER FUNCTION is the same defect in Solid's shape — the spec still builds the subject (Solid's render() takes a function)",
        code: "export interface P {\n  mount(element: () => JSX.Element): void;\n}\n",
        errors: [{ messageId: "acceptsElement" }],
      },
      {
        name: "a render function returning a ReactElement (the RN wrapper shape)",
        code: "export interface P {\n  mount(wrapper: () => ReactElement): void;\n}\n",
        errors: [{ messageId: "acceptsElement" }],
      },
      {
        name: "a contract taking a bare ReactElement is the defect",
        code: "export interface P {\n  mount(element: ReactElement): void;\n}\n",
        errors: [{ messageId: "acceptsElement" }],
      },
      {
        name: "JSX.Element is the same defect spelled differently",
        code: "export interface P {\n  mount(tree: JSX.Element): void;\n}\n",
        errors: [{ messageId: "acceptsElement" }],
      },
      {
        name: "React.ReactElement is caught through the qualified name too",
        code: "export interface P {\n  mount(tree: React.ReactElement): void;\n}\n",
        errors: [{ messageId: "acceptsElement" }],
      },
      {
        name: "a generic ReactElement<Props> is still a rendered element",
        code: "export interface P {\n  mount(element: ReactElement<DockProps>): void;\n}\n",
        errors: [{ messageId: "acceptsElement" }],
      },
      {
        name: "both mount and rerender are reported — each leaks the arrange half",
        code: "export interface P {\n  mount(element: ReactElement): void;\n  rerender(element: ReactElement): void;\n}\n",
        errors: [
          { messageId: "acceptsElement" },
          { messageId: "acceptsElement" },
        ],
      },
    ],
  },
);
