import { RuleTester } from "@typescript-eslint/rule-tester";
import tseslint from "typescript-eslint";
import { afterAll, describe, it } from "vitest";

import { newspaperOrder } from "./newspaper-order.mts";

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

ruleTester.run("newspaper-order", newspaperOrder, {
  valid: [
    {
      name: "helpers already below the tests",
      code: `import { describe, it } from "vitest";

describe("x", () => {
  it("works", () => {
    helper();
  });
});

function helper() {
  return 1;
}
`,
    },
    {
      name: "no test statements -> rule does nothing",
      code: `export function add(a: number, b: number): number {
  return a + b;
}
`,
    },
    {
      name: "class before describe is left in place (not hoisted)",
      code: `import { describe, it } from "vitest";

class FakeWs {}

describe("x", () => {
  it("uses fake", () => {
    new FakeWs();
  });
});
`,
    },
    {
      name: "vi.doMock before describe is left in place (not hoisted)",
      code: `import { describe, it, vi } from "vitest";

vi.doMock("./dep", () => ({ default: 1 }));

describe("x", () => {
  it("works", () => {});
});
`,
    },
    {
      name: "jest.doMock before describe is left in place (not hoisted)",
      code: `jest.doMock("./dep", () => ({ default: 1 }));

describe("x", () => {
  it("works", () => {});
});
`,
    },
    {
      name: "const after a test is not policed",
      code: `import { describe, it } from "vitest";

describe("x", () => {
  it("works", () => {});
});

const AFTER = 1;
`,
    },
    {
      name: "fixture: a const referenced in a DESCRIBE BODY runs at collection time — not movable",
      code: `import { describe, it, expect } from "vitest";

const CASES = [1, 2];

describe("x", () => {
  for (const c of CASES) {
    it(\`works \${c}\`, () => {
      expect(c).toBe(c);
    });
  }
});
`,
    },
    {
      name: "fixture: a const reached through a helper the DESCRIBE BODY calls is not movable",
      code: `import { describe, it, expect } from "vitest";

const SEED = { a: 1 };

describe("x", () => {
  build();
  it("works", () => {
    expect(build().a).toBe(1);
  });
});

function build() {
  return SEED;
}
`,
    },
    {
      name: "fixture: a const reached through a helper CALLED at module level is not movable",
      code: `import { describe, it, expect } from "vitest";

const SEED = { a: 1 };

build();

describe("x", () => {
  it("works", () => {
    expect(build().a).toBe(1);
  });
});

function build() {
  return SEED;
}
`,
    },
    {
      name: "fixture: a vi.hoisted const stays put",
      code: `import { describe, it, expect, vi } from "vitest";

const captured = vi.hoisted(() => {
  return { seen: [] };
});

describe("x", () => {
  it("works", () => {
    expect(captured.seen).toEqual([]);
  });
});
`,
    },
    {
      name: "fixture GROUP: a fixture feeding a BLOCKED fixture is blocked too",
      code: `import { describe, it, expect } from "vitest";

const inner = { a: 1 };

const outer = { inner };

describe("x", () => {
  if (!outer) {
    throw new Error("missing");
  }

  it("works", () => {
    expect(outer.inner.a).toBe(1);
  });
});
`,
    },
    {
      name: "describe scope: helpers already at the bottom of their block",
      code: `import { describe, it, expect } from "vitest";

describe("x", () => {
  it("works", () => {
    expect(helper()).toBe(1);
  });

  function helper() {
    return 1;
  }
});
`,
    },
    {
      name: "describe scope: a block-scoped const a NESTED describe reads is not movable",
      code: `import { describe, it, expect } from "vitest";

describe("outer", () => {
  const cases = [1, 2];

  describe("inner", () => {
    for (const c of cases) {
      it(\`works \${c}\`, () => {
        expect(c).toBe(c);
      });
    }
  });
});
`,
    },
    {
      name: "fixture: a fixture a vi.mock factory closes over stays put",
      code: `import { describe, it, expect, vi } from "vitest";

const mockValue = { a: 1 };

describe("x", () => {
  it("works", () => {
    expect(mockValue.a).toBe(1);
  });
});

vi.mock("./dep", () => {
  return { value: mockValue };
});
`,
    },
  ],
  invalid: [
    {
      name: "function helper before describe is moved to the bottom",
      code: `import { describe, it, expect } from "vitest";

function helper() {
  return 1;
}

describe("x", () => {
  it("works", () => {
    expect(helper()).toBe(1);
  });
});
`,
      output: `import { describe, it, expect } from "vitest";

describe("x", () => {
  it("works", () => {
    expect(helper()).toBe(1);
  });
});

function helper() {
  return 1;
}
`,
      errors: [{ messageId: "moveDown", data: { count: "1" } }],
    },
    {
      name: "type alias before describe is moved down",
      code: `import { describe, it } from "vitest";

type Foo = { a: number };

describe("x", () => {
  it("works", () => {
    const f: Foo = { a: 1 };
  });
});
`,
      output: `import { describe, it } from "vitest";

describe("x", () => {
  it("works", () => {
    const f: Foo = { a: 1 };
  });
});

type Foo = { a: number };
`,
      errors: [{ messageId: "moveDown", data: { count: "1" } }],
    },
    {
      name: "vi.mock before describe is moved down (vitest hoists it anyway)",
      code: `import { describe, it, vi } from "vitest";

vi.mock("./dep");

describe("x", () => {
  it("works", () => {});
});
`,
      output: `import { describe, it, vi } from "vitest";

describe("x", () => {
  it("works", () => {});
});

vi.mock("./dep");
`,
      errors: [{ messageId: "moveDown", data: { count: "1" } }],
    },
    {
      name: "jest.mock before describe is moved down (jest hoists it anyway)",
      code: `jest.mock("./dep");

describe("x", () => {
  it("works", () => {});
});
`,
      output: `describe("x", () => {
  it("works", () => {});
});

jest.mock("./dep");
`,
      errors: [{ messageId: "moveDown", data: { count: "1" } }],
    },
    {
      name: "leading line comment travels with the helper",
      code: `import { describe, it } from "vitest";

// makes a thing
function helper() {
  return 1;
}

describe("x", () => {
  it("works", () => {
    helper();
  });
});
`,
      output: `import { describe, it } from "vitest";

describe("x", () => {
  it("works", () => {
    helper();
  });
});

// makes a thing
function helper() {
  return 1;
}
`,
      errors: [{ messageId: "moveDown", data: { count: "1" } }],
    },
    {
      name: "curried describe.each is recognized as a test boundary",
      code: `import { describe, it } from "vitest";

function helper() {
  return 1;
}

describe.each([1, 2])("case %s", (n) => {
  it("works", () => {
    helper();
  });
});
`,
      output: `import { describe, it } from "vitest";

describe.each([1, 2])("case %s", (n) => {
  it("works", () => {
    helper();
  });
});

function helper() {
  return 1;
}
`,
      errors: [{ messageId: "moveDown", data: { count: "1" } }],
    },
    {
      name: "two helpers before describe keep their original order at the bottom",
      code: `import { describe, it } from "vitest";

function a() {
  return 1;
}

function b() {
  return 2;
}

describe("x", () => {
  it("works", () => {
    a();
    b();
  });
});
`,
      output: `import { describe, it } from "vitest";

describe("x", () => {
  it("works", () => {
    a();
    b();
  });
});

function a() {
  return 1;
}

function b() {
  return 2;
}
`,
      errors: [{ messageId: "moveDown", data: { count: "2" } }],
    },
    {
      name: "a const referenced only inside it() is moved to the bottom — by default, no option",
      code: `import { describe, it, expect } from "vitest";

const FIXTURE = { a: 1 };

describe("x", () => {
  it("works", () => {
    expect(FIXTURE.a).toBe(1);
  });
});
`,
      output: `import { describe, it, expect } from "vitest";

describe("x", () => {
  it("works", () => {
    expect(FIXTURE.a).toBe(1);
  });
});

const FIXTURE = { a: 1 };
`,
      errors: [{ messageId: "moveDown", data: { count: "1" } }],
    },
    {
      name: "fixture: a let referenced only inside a hook callback is moved down",
      code: `import { describe, it, afterEach, expect } from "vitest";

let attached = [];

afterEach(() => {
  attached = [];
});

describe("x", () => {
  it("works", () => {
    expect(attached).toEqual([]);
  });
});
`,
      output: `import { describe, it, afterEach, expect } from "vitest";

afterEach(() => {
  attached = [];
});

describe("x", () => {
  it("works", () => {
    expect(attached).toEqual([]);
  });
});

let attached = [];
`,
      errors: [{ messageId: "moveDown", data: { count: "1" } }],
    },
    {
      name: "fixture: a const and a function above the tests both move, order preserved",
      code: `import { describe, it, expect } from "vitest";

const FIXTURE = { a: 1 };

function helper() {
  return 2;
}

describe("x", () => {
  it("works", () => {
    expect(FIXTURE.a + helper()).toBe(3);
  });
});
`,
      output: `import { describe, it, expect } from "vitest";

describe("x", () => {
  it("works", () => {
    expect(FIXTURE.a + helper()).toBe(3);
  });
});

const FIXTURE = { a: 1 };

function helper() {
  return 2;
}
`,
      errors: [{ messageId: "moveDown", data: { count: "2" } }],
    },
    {
      name: "fixture: a const reached through a helper only it() calls IS movable (transitive)",
      code: `import { describe, it, expect } from "vitest";

const SEED = { a: 1 };

describe("x", () => {
  it("works", () => {
    expect(build().a).toBe(1);
  });
});

function build() {
  return SEED;
}
`,
      output: `import { describe, it, expect } from "vitest";

describe("x", () => {
  it("works", () => {
    expect(build().a).toBe(1);
  });
});

function build() {
  return SEED;
}

const SEED = { a: 1 };
`,
      errors: [{ messageId: "moveDown", data: { count: "1" } }],
    },
    {
      name: "fixture GROUP: a fixture reached only through another MOVING fixture moves with it",
      code: `import { describe, it, expect } from "vitest";

const user = { name: "Demo" };

const session = { user, token: "t" };

describe("x", () => {
  it("works", () => {
    expect(session.user.name).toBe("Demo");
  });
});
`,
      output: `import { describe, it, expect } from "vitest";

describe("x", () => {
  it("works", () => {
    expect(session.user.name).toBe("Demo");
  });
});

const user = { name: "Demo" };

const session = { user, token: "t" };
`,
      errors: [{ messageId: "moveDown", data: { count: "2" } }],
    },
    {
      name: "describe scope: a helper above the tests moves to the END OF ITS BLOCK, not the file",
      code: `import { describe, it, expect } from "vitest";

describe("x", () => {
  function helper() {
    return 1;
  }

  it("works", () => {
    expect(helper()).toBe(1);
  });
});
`,
      output: `import { describe, it, expect } from "vitest";

describe("x", () => {
  it("works", () => {
    expect(helper()).toBe(1);
  });

  function helper() {
    return 1;
  }
});
`,
      errors: [{ messageId: "moveDown", data: { count: "1" } }],
    },
    {
      name: "describe scope: a block-scoped fixture read only inside it() moves down",
      code: `import { describe, it, expect } from "vitest";

describe("x", () => {
  const seed = { a: 1 };

  it("works", () => {
    expect(seed.a).toBe(1);
  });
});
`,
      output: `import { describe, it, expect } from "vitest";

describe("x", () => {
  it("works", () => {
    expect(seed.a).toBe(1);
  });

  const seed = { a: 1 };
});
`,
      errors: [{ messageId: "moveDown", data: { count: "1" } }],
    },
    {
      name: "fixture GROUP: a fixture read by an ALREADY-BELOW fixture lands just above it",
      code: `import { describe, it, expect } from "vitest";

const user = { name: "Demo" };

describe("x", () => {
  it("works", () => {
    expect(session.user.name).toBe("Demo");
  });
});

const session = { user, token: "t" };
`,
      output: `import { describe, it, expect } from "vitest";

describe("x", () => {
  it("works", () => {
    expect(session.user.name).toBe("Demo");
  });
});

const user = { name: "Demo" };

const session = { user, token: "t" };
`,
      errors: [{ messageId: "moveDown", data: { count: "1" } }],
    },
    {
      name: "fixture: a fixture a jest.mock FACTORY closes over stays put (factories are hoisted above imports)",
      code: `import { describe, it, expect } from "@jest/globals";

const mockValue = { a: 1 };

jest.mock("./dep", () => {
  return { value: mockValue };
});

describe("x", () => {
  it("works", () => {
    expect(mockValue.a).toBe(1);
  });
});
`,
      output: `import { describe, it, expect } from "@jest/globals";

const mockValue = { a: 1 };

describe("x", () => {
  it("works", () => {
    expect(mockValue.a).toBe(1);
  });
});

jest.mock("./dep", () => {
  return { value: mockValue };
});
`,
      errors: [{ messageId: "moveDown", data: { count: "1" } }],
    },
  ],
});
