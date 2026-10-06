#!/usr/bin/env node
// Checks the project's Dockerfiles for three things an image build gets wrong
// without anyone seeing it.
//
//   node tools/ci-security/check-dockerfiles.mts
//
//   base image   every image the build pulls is named by digest (`@sha256:` and
//                64 lowercase hex digits), not by a tag alone: every FROM, every
//                `COPY --from=` and every `RUN --mount=…,from=` that names an
//                image. A tag is moved to a new image whenever its owner likes;
//                a digest names one image for good, so what is built is what
//                was reviewed.
//   user         the last stage ends as a user that is not root. The build
//                needs root; the running program does not, and without this a
//                way out of the program is a root shell in the container.
//   packages     no RUN installs a package outside a lockfile (`npm install
//                -g`, `npx`, `pnpm dlx`). Such a package has no pinned
//                version and no checksum.
//
// It reads files only, so it needs no Docker and no network, and it is part of
// `pnpm gate:fast`.
//
// Exit 0: every Dockerfile passes, or the project has none (SKIP, with the
// reason). Exit 1: findings. A Dockerfile that cannot be read, or that Docker
// would refuse or read in another way than this check, is a finding. Exit 2:
// the check itself could not run.
//
// How a Dockerfile is read. The check reads a file line by line the way
// BuildKit's Dockerfile frontend does, because a rule held on another reading
// is not held:
//
//   - A keyword is in any letter case. A word Docker does not know is a
//     finding, not a line to skip.
//   - A line that ends in the escape character goes on in the next line, with
//     nothing put between the two (`US\` and `ER root` is `USER root`). Blanks
//     after the character do not change that; two of the character do, and so
//     does the end of the file. Comment lines and blank lines inside such an
//     instruction are dropped.
//   - `# escape=` changes that character. It counts only at the very top, with
//     `# syntax=` and `# check=`, before any other line. `# syntax=` may name
//     Docker's own frontend (`docker/dockerfile`) and no other: another
//     frontend reads every line in its own way.
//   - The lines of a heredoc (`RUN <<EOF` … `EOF`) are not instructions. The
//     body of a RUN heredoc is run, so the packages rule reads it. A heredoc
//     is accepted in one form only: `<<NAME`, `<<-NAME`, `<<"NAME"` or
//     `<<'NAME'` as a word of its own, on a line with no other quote, no
//     backslash and no `${`, and with a NAME that is not an instruction. In
//     any other form Docker and this check can differ on where the body ends,
//     and an older Docker reads the body as instructions.
//   - `RUN ["npm", "install"]` is read as the command it runs.
//   - A control character, a space that is not a space or a tab, or a byte
//     order mark anywhere but the start makes the whole file a finding.
//
// What the rules decide where Docker leaves a choice:
//
//   - A variable in an image (`FROM ${BASE}`, `$BASE`, `${BASE:-node@sha256:…}`)
//     is not pinned, whatever its default: `--build-arg` replaces the value on
//     the command line. The rule is one line on purpose. It also refuses a
//     variable in front of a digest.
//   - A FROM names a stage only by the stage's name, in lower case, after that
//     stage. `FROM 0` is the image called `0`, not the first stage. Docker
//     reads it so; `COPY --from=0` is the first stage.
//   - Only `sha256:` is a digest here. A tag in front of it is for the reader:
//     Docker pulls by the digest.
//   - The last stage is the one that ships. `docker build --target` can ship
//     an earlier one, and this check cannot see a command line. For the same
//     reason it does not see `--build-context`, which replaces any image.
//   - A stage that is FROM an earlier stage starts as that stage's user. A
//     stage from an outside image starts as root, as far as this check can
//     know, so it must set USER itself.
//   - USER must be a plain name or number. `USER ${APP}`, `USER "root"` and
//     `USER +0` are not shown to be another user than root, so they fail.
//   - `ONBUILD USER` does not set this stage's user. It acts in the stage that
//     is built FROM this one, and is counted there. `ONBUILD RUN` is held to
//     the packages rule on its own line: it is the same install, one build
//     later.
//
// Which files. `Dockerfile`, `Dockerfile.*`, `*.Dockerfile` and Podman's
// `Containerfile` in the same three forms, in any letter case, in any folder
// but `node_modules` and `.git`. A link with such a name is followed and its
// target judged. A link to a folder is not walked into: its Dockerfiles are
// judged where they are, when that is inside the project.
//
// What it does not see: what a script that is copied in and run installs, a
// command built from variables, `pip`, `apt` and `curl | sh`, and the image
// that `# syntax=docker/dockerfile:1` pulls by its tag. It does not check what
// stands after every instruction: a file Docker refuses for a port that is
// not a number builds no image, and passes here.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./lib/system.mts";

const GATE = "dockerfiles";

/** `Dockerfile`, `Dockerfile.server`, `server.Dockerfile`, and Podman's name for the same file. Docker takes `dockerfile` too. */
const DOCKERFILE = /^(dockerfile|containerfile)(\..+)?$|\.(dockerfile|containerfile)$/i;

/** `Dockerfile.dockerignore` lists what a Dockerfile's build leaves out. It is not a Dockerfile. */
const IGNORE_FILE = /\.dockerignore$/i;

/** Never looked into: installed packages, and git's own files. */
const SKIPPED_FOLDERS = new Set(["node_modules", ".git"]);

/** Every instruction Docker knows. Any other first word stops its build. */
const INSTRUCTIONS = new Set([
  "ADD",
  "ARG",
  "CMD",
  "COPY",
  "ENTRYPOINT",
  "ENV",
  "EXPOSE",
  "FROM",
  "HEALTHCHECK",
  "LABEL",
  "MAINTAINER",
  "ONBUILD",
  "RUN",
  "SHELL",
  "STOPSIGNAL",
  "USER",
  "VOLUME",
  "WORKDIR",
]);

/** The instructions a heredoc can follow. */
const HEREDOC_INSTRUCTIONS = new Set(["RUN", "COPY", "ADD"]);

/** The instructions Docker takes with nothing after them. FROM is not one, and has a finding of its own. */
const MAY_STAND_ALONE = new Set(["RUN", "CMD", "ENTRYPOINT", "FROM"]);

/** What Docker refuses after ONBUILD. */
const NOT_A_TRIGGER = new Set(["ONBUILD", "FROM", "MAINTAINER"]);

/** The parser directives. A comment with any other key is a comment, and ends the directives. */
const DIRECTIVES = new Set(["syntax", "escape", "check"]);

const DIRECTIVE = /^#[ \t]*([a-zA-Z][a-zA-Z0-9]*)[ \t]*=[ \t]*(.+?)[ \t]*$/;

/** Docker's own frontend, from Docker Hub, at any tag or digest. */
const DOCKER_FRONTEND = /^(docker\.io\/)?docker\/dockerfile([:@][A-Za-z0-9._:@-]+)?$/;

/** Docker splits the words of an instruction on these two only. */
const BLANKS = /[ \t]+/;

/** `<<EOF`, `<<-EOF`, `3<<"EOF"`: a heredoc in the one form the check accepts. */
const HEREDOC = /^\d*<<(-?)(?:(\w[\w.-]*)|"(\w[\w.-]*)"|'(\w[\w.-]*)')$/;

/** In a word of a heredoc line, what makes Docker's word ends differ from a split on blanks. */
const UNCLEAR_IN_A_HEREDOC_LINE = /<<|['"\\]|\$\{/;

/** An image by digest. The tag in front of the digest is not what Docker pulls. */
const PINNED = /^[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;

const STAGE_NAME = /^[a-z][a-z0-9-_.]*$/;

/** A user as a plain name or number, with an optional group. Anything else is not shown to be a user other than root. */
const PLAIN_USER = /^([A-Za-z_][A-Za-z0-9_.-]*|[0-9]+)(:[A-Za-z0-9_.-]+)?$/;

/**
 * Code points that are not the text of a Dockerfile: control characters, and
 * spaces that are not a space or a tab. Docker strips some of them and keeps
 * others, and an editor shows them as nothing or as a blank.
 */
const STRANGE_CHARACTERS: [from: number, to: number][] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x7f],
  [0x85, 0x85],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200f],
  [0x2028, 0x202f],
  [0x205f, 0x206f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
  [0xfffd, 0xfffd],
];

const BYTE_ORDER_MARK = 0xfeff;

/** The flag that makes an install global, as one word. */
const GLOBAL_FLAG = /^(-g|--global(=true)?|--location=global)$/;

/** A package manager, the words that make it install, and what the finding calls it. They fail with a global flag. */
const GLOBAL_INSTALLS: { tool: string; verbs: string[]; what: string }[] = [
  { tool: "npm", verbs: ["install", "i", "add", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall"], what: "npm install -g" },
  { tool: "pnpm", verbs: ["add", "install", "i", "update", "up"], what: "pnpm add -g" },
  { tool: "bun", verbs: ["add", "install", "i"], what: "bun add -g" },
];

/** A package manager and the word that makes it fetch a package and run it. */
const FETCH_AND_RUN: { tool: string; verbs: string[]; what: string }[] = [
  { tool: "pnpm", verbs: ["dlx"], what: "dlx" },
  { tool: "yarn", verbs: ["dlx"], what: "dlx" },
  { tool: "npm", verbs: ["exec", "x"], what: "npm exec" },
  { tool: "bun", verbs: ["x"], what: "bun x" },
];

/** A program that fetches a package and runs it. */
const RUNNERS = ["npx", "pnpx", "bunx"];

/** Where one shell command ends and the next starts. */
const COMMAND_ENDS = /[;&|\n(){}`]/;

export interface DockerFinding {
  file: string;
  line: number;
  message: string;
}

export interface DockerCheck {
  gate: string;
  /** Why nothing was judged. A result with this set has not passed. */
  skipped?: string;
  findings: DockerFinding[];
  files: number;
  /** How many FROM lines were judged. */
  images: number;
}

export interface Heredoc {
  name: string;
  /** The lines between the instruction and the line that is the name. */
  body: string;
}

export interface Instruction {
  /** Upper case: FROM, RUN, USER. For `ONBUILD RUN …` this is RUN. */
  keyword: string;
  /** The words that start with `--`, before the first word that does not. */
  flags: string[];
  /** Everything after the keyword and its flags, continuation lines joined. */
  args: string;
  /** The line the instruction starts on. */
  line: number;
  /** True after ONBUILD: the instruction acts in the build of an image that is FROM this one. */
  onbuild: boolean;
  heredocs: Heredoc[];
}

export interface Dockerfile {
  instructions: Instruction[];
  /** Why the file cannot be read as Docker reads it. With this set there are no instructions. */
  unreadable?: { line: number; message: string };
}

/** A user a stage ends as, and the USER line that says so. */
interface User {
  /** What stands after USER. */
  value: string;
  line: number;
  kind: "root" | "other" | "unknown";
  /** True when the line is in a stage this one is built from. */
  inherited: boolean;
}

interface Stage {
  user?: User;
  /** The ONBUILD USER lines, which act in a stage that is FROM this one. */
  triggers: Instruction[];
}

/** A Dockerfile Docker would refuse, or read in another way than this check. */
class Unreadable extends Error {
  line: number;

  constructor(line: number, message: string) {
    super(message);
    this.line = line;
  }
}

export function checkDockerfiles(root: string): DockerCheck {
  const files = listDockerfiles(root);

  if (files.length === 0) {
    return { gate: GATE, skipped: "the project has no Dockerfile, so there was nothing to check", findings: [], files: 0, images: 0 };
  }

  const findings: DockerFinding[] = [];
  let images = 0;

  for (const file of files) {
    const source = readSource(join(root, file));

    if (typeof source !== "string") {
      findings.push({ file, line: 1, message: source.problem });
      continue;
    }

    const { instructions, unreadable } = parseDockerfile(source);

    if (unreadable !== undefined) {
      findings.push({ file, line: unreadable.line, message: `${unreadable.message} Nothing else in this file was judged.` });
      continue;
    }

    images += instructions.filter(({ keyword, onbuild }) => keyword === "FROM" && !onbuild).length;
    findings.push(...checkOne(file, instructions));
  }

  return { gate: GATE, findings, files: files.length, images };
}

/** The text of a Dockerfile, or why there is none. A link is followed. */
function readSource(path: string): string | { problem: string } {
  try {
    if (!statSync(path).isFile()) {
      return { problem: "This is named like a Dockerfile and is not a file (a link to a folder, or a device), so it could not be judged. Rename it, or remove it." };
    }

    return readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return { problem: `This Dockerfile could not be read, so it was not judged, and a file that is not judged has not passed: ${reason}` };
  }
}

function checkOne(file: string, instructions: Instruction[]): DockerFinding[] {
  const findings: DockerFinding[] = [];
  /** Every stage so far, in order: what `COPY --from=<number>` counts. */
  const stages: Stage[] = [];
  /** The stages that have a name, by that name in lower case. */
  const named = new Map<string, Stage>();
  let stage: Stage | undefined;
  let lastFrom: Instruction | undefined;

  for (const instruction of instructions) {
    const { keyword, args, line, onbuild } = instruction;

    if (keyword === "FROM") {
      const { image, name, problem } = readFrom(instruction);
      const base = named.get(image);
      const message = problem ?? (base === undefined ? judgeImage(image, `The base image is \`${image}\``, `FROM ${withoutDigest(image)}@sha256:<digest>`) : undefined);

      findings.push(...(message === undefined ? [] : [{ file, line, message }]));
      stage = { user: userFromBase(base), triggers: [] };
      stages.push(stage);
      lastFrom = instruction;

      if (name !== undefined) {
        named.set(name, stage);
      }

      continue;
    }

    if (stage === undefined) {
      // Docker takes ARG before the first FROM, and nothing else.
      if (keyword !== "ARG" || onbuild) {
        findings.push({ file, line, message: `This ${keyword} stands before the first FROM, where Docker takes only ARG, so it does not build this file. Move it after the FROM.` });
      }

      continue;
    }

    if (keyword === "USER") {
      if (onbuild) {
        stage.triggers.push(instruction);
      } else {
        stage.user = readUser(args, line, false);
      }
    }

    for (const image of readSourceImages(instruction)) {
      // An earlier stage, by its name in any letter case, or for COPY by its number. Not the stage the line is in.
      const byName = named.get(image.toLowerCase());
      const byNumber = keyword !== "RUN" && /^\d+$/.test(image) && Number(image) < stages.length - 1;
      const isStage = (byName !== undefined && byName !== stage) || byNumber;
      const message = isStage ? undefined : judgeImage(image, `This ${keyword} takes files from the image \`${image}\``, `from=${withoutDigest(image)}@sha256:<digest>`);

      findings.push(...(message === undefined ? [] : [{ file, line, message }]));
    }

    if (keyword === "RUN") {
      for (const what of listUnpinnedInstalls(instruction)) {
        findings.push({
          file,
          line,
          message: `This RUN installs a package outside a lockfile (${what}). The version is whatever the registry gives on the day of the build, and nothing checks what was downloaded. Put the package in a package.json with a lockfile, copy both into the image, and install with \`npm ci\` or \`pnpm install --frozen-lockfile\`.`,
        });
      }
    }
  }

  if (lastFrom === undefined) {
    return [...findings, { file, line: 1, message: "There is no FROM line, so this is not a Dockerfile that builds. Remove the file, or give it a base image." }];
  }

  return [...findings, ...checkUser(file, lastFrom, stage?.user)];
}

/** The finding for the user the last stage ends as, if that is root or cannot be told. */
function checkUser(file: string, lastFrom: Instruction, user: User | undefined): DockerFinding[] {
  const advice = "`USER node` in an official Node image, or a user the Dockerfile creates";

  if (user === undefined) {
    return [
      {
        file,
        line: lastFrom.line,
        message: `The last stage sets no USER, and no stage it is built from sets one, so the program in the container runs as root, and a way out of the program is a root shell. A base image from outside may set a user; this check cannot see it. Add a USER line after the last step that needs root (an install, a build): ${advice}.`,
      },
    ];
  }

  const where = user.inherited ? ` (set in a stage this one is built from, at line ${user.line})` : "";

  if (user.kind === "root") {
    return [
      {
        file,
        line: user.line,
        message: `The last stage ends as \`USER ${user.value}\`${where}, so the program in the container runs as root. End it as a user that is not root: ${advice}.`,
      },
    ];
  }

  if (user.kind === "unknown") {
    return [
      {
        file,
        line: user.line,
        message: `The last stage ends as \`USER ${user.value}\`${where}, which this check cannot show to be a user other than root: a variable is set at build time, and Docker takes quotes, a backslash and a sign out of the name before it uses it. Write the user out as a plain name or number: ${advice}.`,
      },
    ];
  }

  return [];
}

/** The user a stage starts as: its base stage's, then what that stage's ONBUILD USER lines set. */
function userFromBase(base: Stage | undefined): User | undefined {
  if (base === undefined) {
    return undefined;
  }

  const trigger = base.triggers.at(-1);

  if (trigger !== undefined) {
    return readUser(trigger.args, trigger.line, true);
  }

  return base.user === undefined ? undefined : { ...base.user, inherited: true };
}

function readUser(value: string, line: number, inherited: boolean): User {
  const [, user] = PLAIN_USER.exec(value) ?? [];

  if (user === undefined) {
    return { value, line, kind: "unknown", inherited };
  }

  return { value, line, kind: user === "root" || /^0+$/.test(user) ? "root" : "other", inherited };
}

/** Why an image is not pinned, or nothing when it is. `scratch` is the empty image. */
function judgeImage(image: string, lead: string, pinned: string): string | undefined {
  if (image === "scratch" || PINNED.test(image)) {
    return undefined;
  }

  if (image.includes("$")) {
    return `${lead}, which holds a build argument, so which image is built is decided on the command line (\`--build-arg\`) and cannot be checked here. A default that is pinned does not change that. Write the image out, with its digest: \`${pinned}\`.`;
  }

  if (image.includes("@")) {
    return `${lead}, and what follows the \`@\` is not a digest this check accepts: \`sha256:\` and 64 lowercase hex digits, with nothing after them. One that is cut short, in upper case or of another kind does not name an image that was reviewed. Take the digest from the registry: \`${pinned}\`.`;
  }

  return `${lead}, with no digest. A tag is moved to a new image whenever its owner pushes one, so two builds of one commit can differ and the image that runs is not the one that was reviewed. Keep the tag for the reader and add the digest: \`${pinned}\`. \`docker buildx imagetools inspect ${image}\` prints it on its Digest line; that one covers every platform.`;
}

function withoutDigest(image: string): string {
  return image.split("@")[0] ?? image;
}

/** `--platform=linux/amd64 node:26@sha256:… AS build` → the image and the stage's name, or why Docker refuses the line. */
function readFrom({ flags, args }: Instruction): { image: string; name?: string; problem?: string } {
  const words = args.split(BLANKS).filter((word) => word !== "");
  const [image = "", as = "", name = ""] = words;
  const unknownFlag = flags.find((flag) => !flag.startsWith("--platform="));

  if (unknownFlag !== undefined) {
    return { image, problem: `Docker knows no FROM flag \`${unknownFlag}\`, so it does not build this file. \`--platform=\` is the only one.` };
  }

  if (words.length === 1) {
    return { image };
  }

  if (words.length !== 3 || as.toUpperCase() !== "AS") {
    return { image, problem: `This FROM has ${words.length} words after it. Docker takes an image, or an image, \`AS\` and a name, so it does not build this file. A comment goes on a line of its own.` };
  }

  if (!STAGE_NAME.test(name.toLowerCase())) {
    return { image, problem: `\`${name}\` is not a name Docker takes for a stage: a letter, then letters, digits, \`-\`, \`_\` and \`.\`.` };
  }

  return { image, name: name.toLowerCase() };
}

/** The images an instruction takes files from: `COPY --from=`, and `from=` in a `RUN --mount=`. */
function readSourceImages({ keyword, flags }: Instruction): string[] {
  if (keyword === "COPY" || keyword === "ADD") {
    return flags.filter((flag) => flag.startsWith("--from=")).map((flag) => flag.slice("--from=".length));
  }

  if (keyword !== "RUN") {
    return [];
  }

  return flags
    .filter((flag) => flag.startsWith("--mount="))
    .flatMap((flag) => flag.slice("--mount=".length).split(","))
    .filter((field) => /^from=/i.test(field))
    .map((field) => field.slice("from=".length));
}

/** What a RUN installs outside a lockfile, by the command that does it. */
function listUnpinnedInstalls({ args, heredocs }: Instruction): string[] {
  const exec = readExecForm(args);
  const scripts = exec === undefined ? [args, ...heredocs.map(({ body }) => body)] : [exec.join(" ")];

  return [...new Set(scripts.flatMap(listUnpinnedInstallsIn))];
}

function listUnpinnedInstallsIn(script: string): string[] {
  // A comment line of the script is dropped. The shell takes quotes and backslashes out before
  // it runs the words: `n\pm`, `"npm"` and `npm` are one command.
  const plain = script
    .replace(/^\s*#.*$/gm, "")
    .replace(/\\\n/g, "")
    .replace(/['"\\]/g, "");

  return plain.split(COMMAND_ENDS).flatMap((command) => {
    // `/usr/local/bin/npm` is npm.
    const words = command.split(/\s+/).map((word) => word.replace(/^.*\//, ""));
    const isGlobal = words.some((word, index) => GLOBAL_FLAG.test(word) || (word === "--location" && words[index + 1] === "global"));
    const runs = (tool: string, verbs: string[]): boolean => words.includes(tool) && words.slice(words.indexOf(tool) + 1).some((word) => verbs.includes(word));

    return [
      ...GLOBAL_INSTALLS.filter(({ tool, verbs }) => isGlobal && runs(tool, verbs)).map(({ what }) => what),
      ...(runs("yarn", ["global"]) && words.includes("add") ? ["yarn global add"] : []),
      ...FETCH_AND_RUN.filter(({ tool, verbs }) => runs(tool, verbs)).map(({ what }) => what),
      ...RUNNERS.filter((runner) => words.includes(runner)),
    ];
  });
}

/** `["npm", "ci"]` → its words. Docker reads an instruction as a list only when all of it is a JSON list. */
function readExecForm(args: string): string[] | undefined {
  if (!args.startsWith("[")) {
    return undefined;
  }

  try {
    const list: unknown = JSON.parse(args);

    return Array.isArray(list) ? list.map(String) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The instructions of a Dockerfile, read the way Docker reads them: lines that
 * end in the escape character joined, comments dropped, heredoc bodies kept
 * out of the instructions. A file Docker would refuse, or could read in
 * another way, comes back as unreadable.
 */
export function parseDockerfile(source: string): Dockerfile {
  try {
    return { instructions: readInstructions(source) };
  } catch (error) {
    if (error instanceof Unreadable) {
      return { instructions: [], unreadable: { line: error.line, message: error.message } };
    }

    throw error;
  }
}

function readInstructions(source: string): Instruction[] {
  // Docker drops a byte order mark at the start of the file, and only there.
  const text = source.charCodeAt(0) === BYTE_ORDER_MARK ? source.slice(1) : source;

  refuseStrangeCharacters(text);

  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const { escape, next } = readDirectives(lines);
  const instructions: Instruction[] = [];
  let index = next;

  while (index < lines.length) {
    const start = index + 1;
    const first = (lines[index] ?? "").replace(/^[ \t]+/, "");
    const opening = cutContinuation(first.startsWith("#") ? "" : first, escape);
    let { text: joined, continued } = opening;

    index += 1;

    // A blank line or a comment between two instructions.
    if (opening.text === "" && !opening.continued) {
      continue;
    }

    // The end of the file ends the instruction too: a last line that ends in the character still counts.
    while (continued && index < lines.length) {
      const line = lines[index] ?? "";
      const content = line.replace(/^[ \t]+/, "");

      index += 1;

      // Inside a continued instruction a comment line and a blank line are dropped, and it goes on.
      if (content !== "" && !content.startsWith("#")) {
        const part = cutContinuation(line, escape);

        joined += part.text;
        continued = part.continued;
      }
    }

    const instruction = readInstruction(joined, start, escape);

    for (const { name, chomp } of listHeredocs(instruction, joined, start)) {
      const end = lines.findIndex((line, at) => at >= index && (chomp ? line.replace(/^\t+/, "") : line) === name);

      if (end === -1) {
        throw new Unreadable(start, `The heredoc \`${name}\` never ends: no later line is \`${name}\` and nothing else. Docker refuses the file.`);
      }

      instruction.heredocs.push({ name, body: lines.slice(index, end).join("\n") });
      index = end + 1;
    }

    instructions.push(instruction);
  }

  return instructions;
}

function refuseStrangeCharacters(text: string): void {
  let line = 1;

  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    // A carriage return is the end of a line only in front of a line feed.
    const strange = code === 0x0d ? text.charCodeAt(at + 1) !== 0x0a : STRANGE_CHARACTERS.some(([from, to]) => code >= from && code <= to);

    if (strange) {
      const name = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;

      throw new Unreadable(
        line,
        `This line holds the character ${name}, which is not text: a control character, a byte that is not UTF-8, or a space that is not a space or a tab. Docker and an editor do not show such a line the same way, so the file cannot be judged. Remove the character.`,
      );
    }

    line += code === 0x0a ? 1 : 0;
  }
}

/** The parser directives at the top of the file: the escape character, and the line the instructions start on. */
function readDirectives(lines: string[]): { escape: string; next: number } {
  const seen = new Set<string>();
  let escape = "\\";
  let next = 0;

  for (; next < lines.length; next += 1) {
    const [, key = "", value = ""] = DIRECTIVE.exec((lines[next] ?? "").replace(/^[ \t]+/, "")) ?? [];
    const name = key.toLowerCase();

    // The first line that is not a directive ends them: a later `# escape=` is a comment.
    if (!DIRECTIVES.has(name)) {
      break;
    }

    if (seen.has(name)) {
      throw new Unreadable(next + 1, `The parser directive \`${name}\` is given twice, and Docker refuses that.`);
    }

    seen.add(name);

    if (name === "escape") {
      if (value !== "\\" && value !== "`") {
        throw new Unreadable(next + 1, `\`# escape=${value}\` names an escape character Docker does not take. It is \`\\\` or a backtick.`);
      }

      escape = value;
    }

    if (name === "syntax" && !DOCKER_FRONTEND.test(value)) {
      throw new Unreadable(
        next + 1,
        `\`# syntax=${value}\` hands this file to another frontend than Docker's own, and that program reads every line in its own way, so no rule can be shown to hold. Use \`docker/dockerfile\`, or remove the line.`,
      );
    }
  }

  return { escape, next };
}

/**
 * A line without the escape character it ends in, and whether it goes on in
 * the next line. Blanks after the character are allowed. Two of the character
 * are the character itself, and the line ends there.
 */
function cutContinuation(line: string, escape: string): { text: string; continued: boolean } {
  const body = line.replace(/[ \t]+$/, "");

  if (!body.endsWith(escape) || body.endsWith(escape + escape)) {
    return { text: line, continued: false };
  }

  return { text: body.slice(0, -1), continued: true };
}

/** One joined line as an instruction. `ONBUILD RUN x` comes back as the RUN, marked. */
function readInstruction(joined: string, line: number, escape: string, onbuild = false): Instruction {
  const [, word = "", rest = ""] = /^([^ \t]+)(?:[ \t]+(.*))?$/.exec(joined.trim()) ?? [];
  const keyword = word.toUpperCase();

  if (!INSTRUCTIONS.has(keyword)) {
    throw new Unreadable(line, `Docker knows no instruction \`${word}\`, so it does not build this file. Instructions are words like FROM, RUN and USER; a line that goes on ends in \`${escape}\`.`);
  }

  if (onbuild && NOT_A_TRIGGER.has(keyword)) {
    throw new Unreadable(line, `Docker refuses ${keyword} after ONBUILD, so it does not build this file.`);
  }

  if (keyword === "ONBUILD") {
    return readInstruction(rest, line, escape, true);
  }

  const { flags, args } = splitFlags(rest, line, escape);

  if (args === "" && !MAY_STAND_ALONE.has(keyword)) {
    throw new Unreadable(line, `This ${keyword} has nothing after it, and Docker refuses that, so it does not build this file.`);
  }

  if (HEREDOC_INSTRUCTIONS.has(keyword) && args.startsWith("[") && isListOfOtherThanText(args)) {
    throw new Unreadable(line, `This ${keyword} is a JSON list that holds something other than text in quotes, and Docker refuses that.`);
  }

  return { keyword, flags, args, line, onbuild, heredocs: [] };
}

/** The leading `--` words of an instruction, and what follows them. */
function splitFlags(rest: string, line: number, escape: string): { flags: string[]; args: string } {
  const flags: string[] = [];
  let args = rest.trim();

  while (args.startsWith("--")) {
    const [flag = ""] = args.split(BLANKS);

    args = args.slice(flag.length).trim();

    // `--` alone ends the flags.
    if (flag === "--") {
      break;
    }

    // Docker takes quotes and escapes out of a flag, and a quote can hold a blank.
    if (/['"]/.test(flag) || flag.includes(escape)) {
      throw new Unreadable(line, `The flag \`${flag}\` holds a quote or the escape character, so where it ends and what it says cannot be told from the text. Write it plain: \`--name=value\`.`);
    }

    flags.push(flag);
  }

  return { flags, args };
}

function isListOfOtherThanText(args: string): boolean {
  try {
    const list: unknown = JSON.parse(args);

    return Array.isArray(list) && list.some((item) => typeof item !== "string");
  } catch {
    return false;
  }
}

/** The heredocs an instruction starts, in the order their bodies follow. */
function listHeredocs({ keyword, args }: Instruction, joined: string, line: number): { name: string; chomp: boolean }[] {
  // Docker looks for a heredoc after RUN, COPY and ADD, and not in a JSON list.
  if (!HEREDOC_INSTRUCTIONS.has(keyword) || !joined.includes("<<") || readExecForm(args) !== undefined) {
    return [];
  }

  const heredocs: { name: string; chomp: boolean }[] = [];

  for (const word of joined.trim().split(BLANKS)) {
    const [whole, dash, bare, double, single] = HEREDOC.exec(word) ?? [];
    const name = bare ?? double ?? single ?? "";

    if (whole === undefined && UNCLEAR_IN_A_HEREDOC_LINE.test(word)) {
      throw new Unreadable(
        line,
        `This ${keyword} holds \`<<\`, and the word \`${word}\` makes it unclear where a heredoc starts and where its body ends: Docker and a shell split such a line into words in their own ways. Write the heredoc as a word of its own (\`<<EOF\`, \`<<-EOF\`, \`<<'EOF'\`), and move quotes, backslashes and \`\${…}\` into its body.`,
      );
    }

    if (INSTRUCTIONS.has(name.toUpperCase())) {
      throw new Unreadable(line, `The heredoc is named \`${name}\`, which is an instruction, so a Docker without heredocs reads its last line as one. Name it \`EOF\`.`);
    }

    if (whole !== undefined) {
      heredocs.push({ name, chomp: dash === "-" });
    }
  }

  return heredocs;
}

/** Every Dockerfile in the project, as sorted paths from the root. A link with such a name is one of them. */
export function listDockerfiles(root: string, folder = ""): string[] {
  return readdirSync(join(root, folder), { withFileTypes: true })
    .flatMap((entry) => {
      const path = folder === "" ? entry.name : `${folder}/${entry.name}`;

      if (entry.isDirectory()) {
        return SKIPPED_FOLDERS.has(entry.name) ? [] : listDockerfiles(root, path);
      }

      return DOCKERFILE.test(entry.name) && !IGNORE_FILE.test(entry.name) ? [path] : [];
    })
    .sort();
}

export function formatResult({ gate, skipped, findings, files, images }: DockerCheck): string {
  if (findings.length > 0) {
    return [`FAIL ${gate} (${findings.length})`, ...findings.flatMap(({ file, line, message }) => [`  ${file}:${line}`, `    ${message}`])].join("\n");
  }

  // Nothing to judge is reported as such: it is not a pass.
  return skipped === undefined ? `PASS ${gate} — ${files} Dockerfile(s), ${images} FROM line(s)` : `SKIP ${gate} — ${skipped}`;
}

if (isMainModule(import.meta.url)) {
  try {
    const result = checkDockerfiles(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

    console.log(formatResult(result));
    process.exitCode = result.findings.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(`check:dockerfiles could not run: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
