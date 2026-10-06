// The npm packages the lint rules need beyond `eslint` and `typescript-eslint`.
//
// A project that updates its kit gets the kit's files and nothing else: a
// dependency added here is not in its package.json. So the list is read in two
// places. The lint config says which one is missing, in words, instead of
// stopping with "cannot find module"; and `add-to-project.mts` lists each one
// the project has not installed under "Still to do by hand".

export interface LintDependency {
  name: string;
  /** The range a project is told to install. */
  version: string;
  /** What cannot be checked without it: the subject of "… need it". */
  neededFor: string;
}

export const REACT_HOOKS: LintDependency = {
  name: "eslint-plugin-react-hooks",
  version: "^7.1.1",
  neededFor: "The rules for React code in a client package",
};

export const LINT_DEPENDENCIES: LintDependency[] = [REACT_HOOKS];
