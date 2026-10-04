import { RuleTester } from "@typescript-eslint/rule-tester";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";

import { noRealSleepsInTests } from "./no-real-sleeps-in-tests.mts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2023,
    sourceType: "module",
  },
});

ruleTester.run("no-real-sleeps-in-tests", noRealSleepsInTests, {
  valid: [
    {
      name: "advancing fake timers is the prescribed form",
      code: "await vi.advanceTimersByTimeAsync(300);",
    },
    {
      name: "a bare timer callback is scheduling, not a sleep",
      code: "setTimeout(() => { subject.next(1); }, 50);",
    },
    {
      name: "a promise that settles without a timer is not a sleep",
      code: "await new Promise((resolve) => { queueMicrotask(resolve); });",
    },
    {
      name: "waiting on a condition is not a fixed wait",
      code: "await page.waitForSelector('[data-testid=row]');",
    },
    {
      name: "a local function that happens to be called setTimeout-like is left alone",
      code: "import { sleepUntilSettled } from './helpers'; await sleepUntilSettled();",
    },
    {
      name: "importing the promise timers module for something else",
      code: "import { setImmediate } from 'node:timers/promises'; await setImmediate();",
    },
  ],
  invalid: [
    {
      name: "the classic one-line sleep",
      code: "await new Promise((resolve) => setTimeout(resolve, 100));",
      errors: [{ messageId: "promiseSleep" }],
    },
    {
      name: "the sleep with a block body and a wrapped resolve",
      code: "await new Promise((resolve) => { setTimeout(() => { resolve(); }, 50); });",
      errors: [{ messageId: "promiseSleep" }],
    },
    {
      name: "a function-expression executor",
      code: "await new Promise(function (resolve) { setTimeout(resolve, 10); });",
      errors: [{ messageId: "promiseSleep" }],
    },
    {
      name: "the timer reached through globalThis",
      code: "await new Promise((resolve) => globalThis.setTimeout(resolve, 10));",
      errors: [{ messageId: "promiseSleep" }],
    },
    {
      name: "a sleep helper declared in the spec is still a sleep",
      code: "const createPause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));",
      errors: [{ messageId: "promiseSleep" }],
    },
    {
      name: "the driver's fixed wait",
      code: "await page.waitForTimeout(500);",
      errors: [{ messageId: "fixedWait" }],
    },
    {
      name: "the promise-returning timer from node",
      code: "import { setTimeout } from 'node:timers/promises'; await setTimeout(100);",
      errors: [{ messageId: "timersPromises" }],
    },
    {
      name: "the promise-returning timer under an alias",
      code: "import { setTimeout as sleep } from 'timers/promises'; await sleep(100);",
      errors: [{ messageId: "timersPromises" }],
    },
  ],
});
