import type { Machine, SelectionIntents, SelectionState } from "@app/client-core";
import { createSelectionMachine } from "@app/client-core";
import { describe, expect, it } from "vitest";

import { mountMachine } from "./useMachine.page.tsx";

describe("useMachine", () => {
  it("gives the component the machine's state and intents", async () => {
    const page = mountMachine(createSelectionMachine);

    expect(page.state()).toEqual({ selected: null });

    await page.send((intents) => intents.select("EURUSD"));

    expect(page.state()).toEqual({ selected: "EURUSD" });
  });

  it("keeps the machine alive through StrictMode's mount, unmount and remount", async () => {
    const counted = createCountedMachines();
    const page = mountMachine(counted.createMachine, { strict: true });

    await page.send((intents) => intents.select("EURUSD"));

    expect(page.state()).toEqual({ selected: "EURUSD" });
    expect(counted.disposed()).toBe(0);
  });

  it("disposes the machine once, on unmount", async () => {
    const counted = createCountedMachines();
    const page = mountMachine(counted.createMachine);

    await page.unmount();

    expect(counted.disposed()).toBe(1);
  });
});

interface CountedMachines {
  createMachine: () => Machine<SelectionState, SelectionIntents>;
  disposed: () => number;
}

function createCountedMachines(): CountedMachines {
  let disposed = 0;

  return {
    createMachine: (): Machine<SelectionState, SelectionIntents> => {
      const machine = createSelectionMachine();

      return {
        ...machine,
        dispose: (): void => {
          disposed += 1;
          machine.dispose();
        },
      };
    },
    disposed: () => disposed,
  };
}
