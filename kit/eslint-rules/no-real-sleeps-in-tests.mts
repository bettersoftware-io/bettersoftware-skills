// arch/no-real-sleeps-in-tests — a test never waits on the wall clock.
//
// A test that sleeps for real time is slow when it passes and flaky when the
// machine is busy: the sleep is a guess at how long something takes, and a
// loaded CI runner makes the guess wrong. A timer-driven outcome is tested on
// fake timers, advanced by the exact interval (`vi.useFakeTimers()` then
// `vi.advanceTimersByTimeAsync(n)`); a UI or network outcome is awaited by
// condition, never by duration.
//
// Flags, in test files:
// - `new Promise((resolve) => setTimeout(resolve, n))` in any spelling — the
//   executor reaches `setTimeout`, so the promise is a sleep.
// - `<driver>.waitForTimeout(n)` — Playwright's fixed wait.
// - a call to `setTimeout` imported from `node:timers/promises`, under any
//   local name.
//
// Deliberately NOT flagged:
// - A bare `setTimeout(callback, n)`. Under fake timers that is how a test
//   schedules an event; the rule cannot see whether fake timers are on, so it
//   stays out of it.
// - Waits on a condition (`waitForSelector`, `findBy…`, `expect.poll`).

import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

type MessageIds = "promiseSleep" | "fixedWait" | "timersPromises";
type Context = TSESLint.RuleContext<MessageIds, []>;

type Executor =
  | TSESTree.ArrowFunctionExpression
  | TSESTree.FunctionExpression;

const PROMISE_TIMER_MODULES = new Set(["node:timers/promises", "timers/promises"]);
const TIMER_HOSTS = new Set(["globalThis", "window", "self"]);

function isTimerCallee(callee: TSESTree.Expression): boolean {
  if (callee.type === "Identifier") {
    return callee.name === "setTimeout";
  }

  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    TIMER_HOSTS.has(callee.object.name) &&
    callee.property.type === "Identifier" &&
    callee.property.name === "setTimeout"
  );
}

function isExecutor(node: TSESTree.Node | undefined): node is Executor {
  return (
    node?.type === "ArrowFunctionExpression" ||
    node?.type === "FunctionExpression"
  );
}

function isPromiseConstruction(node: TSESTree.Node): node is TSESTree.NewExpression {
  return (
    node.type === "NewExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "Promise"
  );
}

/** The `new Promise(...)` whose executor (at any depth) contains `node`. */
function findEnclosingPromise(
  node: TSESTree.Node,
): TSESTree.NewExpression | undefined {
  let current: TSESTree.Node | undefined = node.parent;
  let child: TSESTree.Node = node;

  while (current) {
    if (
      isPromiseConstruction(current) &&
      current.arguments[0] === child &&
      isExecutor(child)
    ) {
      return current;
    }

    child = current;
    current = current.parent;
  }

  return undefined;
}

export const noRealSleepsInTests: TSESLint.RuleModule<MessageIds> = {
  meta: {
    type: "problem",
    docs: {
      description:
        "A test never sleeps on the wall clock — timer-driven outcomes run on fake timers, everything else waits on a condition",
    },
    schema: [],
    messages: {
      promiseSleep:
        "This promise is a real-time sleep. Put the test on fake timers (`vi.useFakeTimers()` before the code under test is built) and advance by the exact interval with `vi.advanceTimersByTimeAsync(n)`; if the wait is for a UI or network outcome, await that condition instead.",
      fixedWait:
        "`waitForTimeout` waits a fixed duration, which is a guess. Wait for the condition you actually need (a locator, a response, `expect.poll`).",
      timersPromises:
        "`{{name}}` from `timers/promises` is a real-time sleep. Use fake timers and `vi.advanceTimersByTimeAsync(n)`, or await the condition you are waiting for.",
    },
  },
  create(context: Context): TSESLint.RuleListener {
    const promiseTimerNames = new Set<string>();
    const reportedPromises = new Set<TSESTree.NewExpression>();

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration): void {
        if (!PROMISE_TIMER_MODULES.has(node.source.value)) {
          return;
        }

        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier" &&
            specifier.imported.name === "setTimeout"
          ) {
            promiseTimerNames.add(specifier.local.name);
          }
        }
      },
      CallExpression(node: TSESTree.CallExpression): void {
        const { callee } = node;

        if (callee.type === "Identifier" && promiseTimerNames.has(callee.name)) {
          context.report({
            node,
            messageId: "timersPromises",
            data: { name: callee.name },
          });

          return;
        }

        if (
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "waitForTimeout"
        ) {
          context.report({ node, messageId: "fixedWait" });

          return;
        }

        if (!isTimerCallee(callee)) {
          return;
        }

        const promise = findEnclosingPromise(node);

        if (promise && !reportedPromises.has(promise)) {
          reportedPromises.add(promise);
          context.report({ node: promise, messageId: "promiseSleep" });
        }
      },
    };
  },
};
