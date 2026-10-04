import { RuleTester } from "@typescript-eslint/rule-tester";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";

import { nameFunctionsByEffect } from "./name-functions-by-effect.mts";

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

ruleTester.run("name-functions-by-effect", nameFunctionsByEffect, {
  valid: [
    {
      name: "function-typed prop is a SLOT — its declarer must not know the intent",
      code: "type P = { onExecute: (d: Direction) => void };\n",
    },
    {
      name: "optional function-typed prop is a slot",
      code: "type P = { onDone?: () => void };\n",
    },
    {
      name: "method whose SOLE param is an inline callback is an attach point",
      code: "interface A { onTrade(cb: (t: Trade) => void): void }\n",
    },
    {
      name: "attach point via a *Listener-named type alias",
      code: "interface A { onTrade(listener: TradeListener): void }\n",
    },
    {
      name: "attach point as a class method",
      code: "class C {\n  onTrade(listener: TradeListener): void {}\n}\n",
    },
    {
      name: "a private sink method named for its EFFECT stays valid",
      code: "class C {\n  private streamPnlReply(push: (e: Event) => void): void {}\n}\n",
    },
    {
      name: "a PUBLIC attach point is still a slot even though it takes only a callback",
      code: "class C {\n  public onTrade(listener: TradeListener): void {}\n}\n",
    },
    {
      name: "JSX attribute names are never inspected",
      code: "const el = <button onClick={cancelRfq} />;\n",
    },
    {
      name: "vi.fn() spy named after the slot it fills is not a function value",
      code: "const onSelect = vi.fn();\n",
    },
    {
      name: "uninitialised slot capture is not a function value",
      code: "let onMsg: ((m: unknown) => void) | undefined;\n",
    },
    {
      name: "object-literal keys mirror the type and are never inspected",
      code: "const api = { onSort: toggleSort, onExport: exportCsv };\n",
    },
    {
      name: "object-literal method shorthand implementing an interface",
      code: "const log = {\n  onConnect(): void {\n    record();\n  },\n};\n",
    },
    {
      name: "leading verb — Handler is the OBJECT of the verb, not the role",
      code: "function setExportCsvHandler(fn) {}\n",
    },
    {
      name: "apply* is a legitimate effect verb",
      code: "function applySort(rows) {}\n",
    },
    {
      name: "execute* is domain vocabulary in an FX app",
      code: "function executeTrade(d) {}\n",
    },
    {
      name: "update* is legitimate",
      code: "function updateNotional(v) {}\n",
    },
    {
      name: "no capital at the on-boundary",
      code: "function onboardUser() {}\n",
    },
    {
      name: "no capital at the do-boundary",
      code: "function download() {}\n",
    },
    {
      name: "noop is the house idiom for an empty function",
      code: "function noop(): void {}\n",
    },
    {
      name: "an effect verb plus a domain noun",
      code: "function dismissTicket() {}\n",
    },
    {
      name: "attach point via a union of callback types",
      code: "interface A { onUnion(cb: TradeListener | undefined): void }\n",
    },
    {
      name: "attach point via an intersection of callback types",
      code: "interface A { onInter(cb: TradeListener & Meta): void }\n",
    },
    {
      name: "attach point via a constructor type",
      code: "interface A { onCtor(cb: new () => object): void }\n",
    },
    {
      name: "attach-point exemption survives a defaulted callback param",
      code: "function onSelect(cb: (t: Trade) => void = () => {}) {}\n",
    },
  ],
  invalid: [
    {
      name: "handle* function declaration",
      code: "function handleClick() {}\n",
      errors: [{ messageId: "nameByEffect", data: { name: "handleClick" } }],
    },
    {
      name: "on* function declaration receiving event DATA",
      code: "function onMessage(data: unknown) {}\n",
      errors: [{ messageId: "nameByEffect", data: { name: "onMessage" } }],
    },
    {
      name: "handle* binding wrapped in useCallback",
      code: "const handleApply = useCallback(() => {\n  apply();\n}, []);\n",
      errors: [{ messageId: "nameByEffect", data: { name: "handleApply" } }],
    },
    {
      name: "handle* arrow binding",
      code: "const handleSend = () => {\n  send();\n};\n",
      errors: [{ messageId: "nameByEffect", data: { name: "handleSend" } }],
    },
    {
      name: "vacuous verb: process*",
      code: "function processClick() {}\n",
      errors: [{ messageId: "nameByEffect", data: { name: "processClick" } }],
    },
    {
      name: "vacuous verb: do*",
      code: "function doClick() {}\n",
      errors: [{ messageId: "nameByEffect", data: { name: "doClick" } }],
    },
    {
      name: "vacuous verb: perform*",
      code: "function performClick() {}\n",
      errors: [{ messageId: "nameByEffect", data: { name: "performClick" } }],
    },
    {
      name: "vacuous verb: manage*",
      code: "function manageSelection() {}\n",
      errors: [
        { messageId: "nameByEffect", data: { name: "manageSelection" } },
      ],
    },
    {
      name: "vacuous verb: respondTo*",
      code: "function respondToKeyDown() {}\n",
      errors: [
        { messageId: "nameByEffect", data: { name: "respondToKeyDown" } },
      ],
    },
    {
      name: "vacuous verb: reactTo*",
      code: "function reactToFill() {}\n",
      errors: [{ messageId: "nameByEffect", data: { name: "reactToFill" } }],
    },
    {
      name: "bare event noun + Callback suffix, no leading verb",
      code: "const frameCallback = () => {\n  draw();\n};\n",
      errors: [{ messageId: "nameByEffect", data: { name: "frameCallback" } }],
    },
    {
      name: "bare event noun + Handler suffix, no leading verb",
      code: "function clickHandler() {}\n",
      errors: [{ messageId: "nameByEffect", data: { name: "clickHandler" } }],
    },
    {
      name: "bare event noun + Cb suffix",
      code: "const msgCb = () => {\n  route();\n};\n",
      errors: [{ messageId: "nameByEffect", data: { name: "msgCb" } }],
    },
    {
      name: "private class method",
      code: "class C {\n  private handleLoginOutcome(u: string, o: AuthOutcome): void {}\n}\n",
      errors: [
        { messageId: "nameByEffect", data: { name: "handleLoginOutcome" } },
      ],
    },
    {
      name: "class method receiving event DATA is a handler, not an attach point",
      code: "class C {\n  onFill(fill: FillEvent): void {}\n}\n",
      errors: [{ messageId: "nameByEffect", data: { name: "onFill" } }],
    },
    {
      name: "interface method signature with a DATA param",
      code: "interface A { onSort(f: SortField): void }\n",
      errors: [{ messageId: "nameByEffect", data: { name: "onSort" } }],
    },
    {
      name: "interface method signature with NO param — it is what runs",
      code: "interface L { onConnect(): void }\n",
      errors: [{ messageId: "nameByEffect", data: { name: "onConnect" } }],
    },
    {
      name: "attach-point exemption needs the SOLE param to be the callback",
      code: "interface A { onTrade(id: number, cb: TradeListener): void }\n",
      errors: [{ messageId: "nameByEffect", data: { name: "onTrade" } }],
    },
    {
      name: "a PRIVATE method cannot be an attach point — nothing outside can register with it",
      code: "class C {\n  private handlePnl(push: (e: Event) => void): void {}\n}\n",
      errors: [{ messageId: "nameByEffect", data: { name: "handlePnl" } }],
    },
    {
      name: "handle* class field arrow",
      code: "class C {\n  private readonly handleClickField = (): void => {};\n}\n",
      errors: [
        { messageId: "nameByEffect", data: { name: "handleClickField" } },
      ],
    },
    {
      name: "bare event noun + Handler suffix: mouse",
      code: "function mouseHandler() {}\n",
      errors: [{ messageId: "nameByEffect", data: { name: "mouseHandler" } }],
    },
    {
      name: "bare event noun + Callback suffix: scroll",
      code: "const scrollCallback = () => {\n  reposition();\n};\n",
      errors: [{ messageId: "nameByEffect", data: { name: "scrollCallback" } }],
    },
  ],
});
