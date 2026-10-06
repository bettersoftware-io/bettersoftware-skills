// The rules in stylelint.base.json, each with a stylesheet that breaks it.
// These run the real stylelint, through the add-on's own wrapper.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkCss } from "../files/tools/repo-hygiene/check-css.mts";
import { createStyledProject, STYLELINT_ROOT } from "./support.mts";

const REPOSITORY = join(import.meta.dirname, "..", "..", "..");
const ADDON = join(import.meta.dirname, "..");

/** A stylesheet with one rule that holds `declarations`, laid out the way the standard rules want. */
function createRule(...declarations: string[]): string {
  return `.row {\n${declarations.map((declaration) => `  ${declaration};\n`).join("")}}\n`;
}

/** What stylelint says about a project that holds this one stylesheet. */
function lint(css: string, path = "src/ui.css", files: Record<string, string> = {}): { failed: boolean; report: string } {
  return checkCss(createStyledProject({ [path]: css, ...files }));
}

describe("the stylesheets a new project has", () => {
  it("pass as they are: the starter's and the visual add-on's", () => {
    const result = checkCss(
      createStyledProject({
        "packages/client-react/src/index.css": readFileSync(join(REPOSITORY, "starter/packages/client-react/src/index.css"), "utf8"),
        "packages/client-react/tests/visual/host/host.css": readFileSync(
          join(REPOSITORY, "addons/visual/files/packages/client-react/tests/visual/host/host.css"),
          "utf8",
        ),
      }),
    );

    expect(result.report).toBe("");
    expect(result).toMatchObject({ failed: false, files: 2 });
  });
});

describe("the validity rules", () => {
  it.each([
    ["color-no-invalid-hex", ":root {\n  --line: #12345;\n}\n"],
    ["no-duplicate-selectors", ".row {\n  top: 0;\n}\n\n.cell {\n  top: 1px;\n}\n\n.row {\n  left: 0;\n}\n"],
    ["no-invalid-double-slash-comments", "// .cell { top: 0; }\n"],
    ["no-irregular-whitespace", ".row {\n  top: 0;\n}\n"],
    ["declaration-block-no-duplicate-custom-properties", ":root {\n  --gap: 1px;\n  --gap: 2px;\n}\n"],
    ["font-family-no-missing-generic-family-keyword", createRule("font-family: Arial")],
    ["function-linear-gradient-no-nonstandard-direction", createRule("background-image: linear-gradient(top, var(--from), var(--to))")],
    ["string-no-newline", '.row::before {\n  content: "one\ntwo";\n}\n'],
  ])("fail on %s", (rule, css) => {
    const result = lint(css);

    expect(result.report).toContain(rule);
    expect(result.failed).toBe(true);
  });
});

describe("the names", () => {
  it("wants kebab-case for a class in a plain stylesheet, and says what a module wants", () => {
    expect(lint(createRule("top: 0")).failed).toBe(false);
    expect(lint(".price-row {\n  top: 0;\n}\n").failed).toBe(false);

    const result = lint(".priceRow {\n  top: 0;\n}\n");

    expect(result.report).toContain("A class in a plain stylesheet is kebab-case: price-row.");
    expect(result.report).toContain("selector-class-pattern");
    expect(result.failed).toBe(true);
  });

  it("wants camelCase for a class in a CSS Module, where it becomes a property", () => {
    expect(lint(".priceRow {\n  top: 0;\n}\n", "src/ui/PriceRow.module.css").failed).toBe(false);

    const result = lint(".price-row {\n  top: 0;\n}\n", "src/ui/PriceRow.module.css");

    expect(result.report).toContain("A class in a CSS Module is camelCase: priceRow.");
    expect(result.failed).toBe(true);
  });

  it("wants kebab-case for a custom property", () => {
    expect(lint(":root {\n  --color-up: #1a8f4c;\n}\n").failed).toBe(false);

    const result = lint(":root {\n  --colorUp: #1a8f4c;\n}\n");

    expect(result.report).toContain("A custom property is kebab-case: --color-up.");
    expect(result.failed).toBe(true);
  });
});

describe("a colour comes from a token", () => {
  it.each([
    "color: #1a8f4c",
    "color: red",
    "background-color: rgb(26 143 76)",
    "border-color: hsl(145deg 69% 33%)",
    "outline-color: #000",
    "fill: #1a8f4c",
    "stroke: red",
    "border: 1px solid #ccc",
    "background: linear-gradient(#fff, #000)",
    "color: color-mix(in srgb, #fff 18%, transparent)",
  ])("fails on %s", (declaration) => {
    const result = lint(createRule(declaration));

    expect(result.report).toContain("scale-unlimited/declaration-strict-value");
    expect(result.failed).toBe(true);
  });

  it.each([
    "color: var(--color-up)",
    "color: var(--color-up, #1a8f4c)",
    "color: currentcolor",
    "color: inherit",
    "background-color: transparent",
    "fill: none",
    "accent-color: auto",
    "border: 1px solid var(--line)",
    "border: 0",
    "outline: 2px solid currentcolor",
    'background: url("row.png") no-repeat',
    "background: color-mix(in srgb, currentcolor 18%, transparent)",
    "color: color-mix(in oklch, var(--color-up) 40%, var(--color-down))",
  ])("accepts %s", (declaration) => {
    const result = lint(createRule(declaration));

    expect(result.report).toBe("");
    expect(result.failed).toBe(false);
  });

  it("names the property and the value, and says where the colour goes", () => {
    const { report } = lint(createRule("color: #1a8f4c"));

    expect(report).toContain('color: "#1a8f4c" is not a token. Define a colour once, as a custom property');
    expect(report).toContain("use it as var(--color-up)");
  });
});

describe("a comment that switches a rule off", () => {
  const disabled = (comment: string): string => `.row {\n  ${comment}\n  color: red;\n}\n`;

  it("needs a reason after it", () => {
    const result = lint(disabled("/* stylelint-disable-next-line scale-unlimited/declaration-strict-value */"));

    expect(result.report).toContain("--report-descriptionless-disables");
    expect(result.failed).toBe(true);
  });

  it("passes with a reason", () => {
    const result = lint(disabled("/* stylelint-disable-next-line scale-unlimited/declaration-strict-value -- the vendor's own red */"));

    expect(result.report).toBe("");
    expect(result.failed).toBe(false);
  });

  it("fails when it switches off a rule that reports nothing there", () => {
    const result = lint(".row {\n  /* stylelint-disable-next-line color-named -- left over */\n  top: 0;\n}\n");

    expect(result.report).toContain("--report-needless-disables");
    expect(result.failed).toBe(true);
  });

  it("fails when it names a rule the project does not run", () => {
    const result = lint(".row {\n  /* stylelint-disable-next-line no-such-rule -- a typo */\n  top: 0;\n}\n");

    expect(result.report).toContain("--report-invalid-scope-disables");
    expect(result.failed).toBe(true);
  });
});

describe("the two layers", () => {
  it("lets the project's file switch off a rule the base sets", () => {
    const root = JSON.stringify({ extends: ["./stylelint.base.json"], rules: { "selector-class-pattern": null } });

    expect(lint(".priceRow {\n  top: 0;\n}\n", "src/ui.css", { [STYLELINT_ROOT]: root }).failed).toBe(false);
  });

  it("fails on a rule the project sets to a warning: a warning that passes is never fixed", () => {
    const root = JSON.stringify({ extends: ["./stylelint.base.json"], rules: { "declaration-no-important": [true, { severity: "warning" }] } });
    const result = lint(createRule("top: 0 !important"), "src/ui.css", { [STYLELINT_ROOT]: root });

    expect(result.report).toContain("declaration-no-important");
    expect(result.failed).toBe(true);
  });

  it("has a project file that only extends the base", () => {
    expect(JSON.parse(readFileSync(join(ADDON, "files", STYLELINT_ROOT), "utf8"))).toEqual({ extends: ["./stylelint.base.json"] });
  });
});
