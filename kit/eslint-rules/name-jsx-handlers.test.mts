import { RuleTester } from "@typescript-eslint/rule-tester";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";

import { nameJsxHandlers } from "./name-jsx-handlers.mts";

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

ruleTester.run("name-jsx-handlers", nameJsxHandlers, {
  valid: [
    {
      name: "named handler reference is the prescribed form",
      code: "const el = <input onChange={changeNotional} />;",
    },
    {
      name: "named factory call is legal (the factory is named)",
      code: "const el = <button onClick={selectTab(id)} />;",
    },
    {
      name: "member handler reference is legal",
      code: "const el = <button onClick={vmActions.submitTicket} />;",
    },
    {
      name: "non-handler prop takes an inline arrow (render prop)",
      code: "const el = <List renderItem={({ item }) => <Row item={item} />} />;",
    },
    {
      name: "lowercase on-prefix is not a handler slot",
      code: "const el = <Foo once={() => 1} />;",
    },
  ],
  invalid: [
    {
      name: "inline arrow on onClick",
      code: "const el = <button onClick={() => submit()} />;",
      errors: [{ messageId: "inlineHandler" }],
    },
    {
      name: "inline async arrow on onPress",
      code: "const el = <Pressable onPress={async () => { await submit(); }} />;",
      errors: [{ messageId: "inlineHandler" }],
    },
    {
      name: "inline function expression on onChange",
      code: "const el = <input onChange={function (e) { change(e); }} />;",
      errors: [{ messageId: "inlineHandler" }],
    },
    {
      name: "Solid namespaced on:click",
      code: "const el = <button on:click={() => submit()} />;",
      errors: [{ messageId: "inlineHandler" }],
    },
  ],
});
