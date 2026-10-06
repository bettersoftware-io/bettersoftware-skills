import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkDockerfiles, formatResult, listDockerfiles, parseDockerfile } from "../files/tools/ci-security/check-dockerfiles.mts";
import { ADDON, createFolder } from "./support.mts";

const HEX = "ab12".repeat(16);
const DIGEST = `sha256:${HEX}`;
const PINNED = `node:26-slim@${DIGEST}`;

/** A Dockerfile that passes: a pinned base, a lockfile install, and a user that is not root. */
const CLEAN = [
  "# The base image, pinned.",
  `FROM ${PINNED}`,
  "WORKDIR /app",
  "COPY . .",
  "RUN pnpm install --frozen-lockfile",
  "USER node",
  'CMD ["node", "server.js"]',
  "",
].join("\n");

/** A part of each kind of finding that no other kind has. */
const NO_DIGEST = "with no digest";
const BAD_DIGEST = "is not a digest this check accepts";
const VARIABLE = "which holds a build argument";
const NO_USER = "The last stage sets no USER";
const ROOT = "so the program in the container runs as root";
const UNKNOWN_USER = "which this check cannot show to be a user other than root";
const INSTALL = "This RUN installs a package outside a lockfile";
const NOT_JUDGED = "Nothing else in this file was judged.";

/** One row of a table: what the case is, the lines of the Dockerfile, and a part of each finding (none: it passes). */
type Row = [title: string, lines: string, findings: string[]];

/** The same, with the lines that stand before the FROM. */
type RowWithTop = [title: string, top: string, lines: string, findings: string[]];

function findingsOf(dockerfile: string): string[] {
  return checkDockerfiles(createFolder({ Dockerfile: dockerfile })).findings.map(({ line, message }) => `${line}: ${message}`);
}

function expectFindings(dockerfile: string, findings: string[]): void {
  expect(findingsOf(dockerfile)).toEqual(findings.map((finding) => expect.stringContaining(finding)));
}

describe("a project with no Dockerfile", () => {
  it("is skipped with the reason, and never passes", () => {
    const result = checkDockerfiles(createFolder({ "package.json": "{}" }));

    expect(result).toEqual({ gate: "dockerfiles", skipped: "the project has no Dockerfile, so there was nothing to check", findings: [], files: 0, images: 0 });
    expect(formatResult(result)).toBe("SKIP dockerfiles — the project has no Dockerfile, so there was nothing to check");
  });
});

describe("a Dockerfile that follows the rules", () => {
  it("passes, and says how much it judged", () => {
    const result = checkDockerfiles(createFolder({ Dockerfile: CLEAN }));

    expect(result.findings).toEqual([]);
    expect(formatResult(result)).toBe("PASS dockerfiles — 1 Dockerfile(s), 1 FROM line(s)");
  });

  it("counts every FROM, and not an image that only a COPY names", () => {
    const stages = [`FROM --platform=linux/amd64 ${PINNED} AS build`, "RUN make", "FROM build AS test", "FROM scratch", `COPY --from=${PINNED} /app /app`, "USER 1000", ""].join("\n");
    const result = checkDockerfiles(createFolder({ Dockerfile: stages }));

    expect(result.findings).toEqual([]);
    expect(result.images).toBe(3);
  });
});

describe("the base image", () => {
  it("fails on a tag with no digest, and says how to get the digest for that image", () => {
    const [finding = ""] = findingsOf(CLEAN.replace(PINNED, "node:26-slim"));

    expect(finding).toContain("2: The base image is `node:26-slim`, with no digest.");
    expect(finding).toContain("`FROM node:26-slim@sha256:<digest>`");
    expect(finding).toContain("docker buildx imagetools inspect node:26-slim");
  });

  it.each<Row>([
    ["no tag", "FROM node", [`1: The base image is \`node\`, ${NO_DIGEST}`]],
    ["the tag latest", "FROM node:latest", [NO_DIGEST]],
    ["a registry and a tag", "FROM ghcr.io/acme/base:1", [NO_DIGEST]],
    ["a digest cut short", `FROM node:26@sha256:${HEX.slice(2)}`, [`1: The base image is \`node:26@sha256:${HEX.slice(2)}\`, and what follows the \`@\` ${BAD_DIGEST}`]],
    ["a digest too long", `FROM node:26@${DIGEST}ab`, [BAD_DIGEST]],
    ["a digest in upper case", `FROM node:26@sha256:${HEX.toUpperCase()}`, [BAD_DIGEST]],
    ["a digest of another kind", `FROM node:26@sha512:${HEX}${HEX}`, [BAD_DIGEST]],
    ["a digest with no hex", "FROM node:26@sha256:", [BAD_DIGEST]],
    ["a tag after the digest", `FROM node@${DIGEST}:26`, [BAD_DIGEST]],
    ["an image in quotes", `FROM "${PINNED}"`, [BAD_DIGEST]],
    ["a comment after the image", `FROM ${PINNED} # base`, ["1: This FROM has 3 words after it"]],
    ["a word after the stage's name", `FROM ${PINNED} AS build extra`, ["1: This FROM has 4 words after it"]],
    ["a flag Docker does not know", `FROM --pull=always ${PINNED}`, ["1: Docker knows no FROM flag `--pull=always`"]],
    ["a stage name Docker refuses", `FROM ${PINNED} AS 1st`, ["1: `1st` is not a name Docker takes for a stage"]],
    ["no image at all", "FROM", ["1: This FROM has 0 words after it"]],
  ])("fails on %s", (_title, from, findings) => {
    expectFindings(createDockerfile("USER node", { from }), findings);
  });

  it.each<Row>([
    ["a tag and a digest", `FROM ${PINNED}`, []],
    ["a digest and no tag", `FROM node@${DIGEST}`, []],
    ["a registry with a port", `FROM localhost:5000/acme/base:1.2@${DIGEST}`, []],
    ["a platform, then the image, AS a name", `FROM --platform=linux/amd64 ${PINNED} AS build`, []],
    ["a platform from a build argument", `FROM --platform=$BUILDPLATFORM ${PINNED}`, []],
    ["the keywords in lower case", `from ${PINNED} as build`, []],
    ["tabs between the words", `FROM\t${PINNED}\tAS\tbuild`, []],
    ["the empty image", "FROM scratch", []],
  ])("accepts %s", (_title, from, findings) => {
    expectFindings(createDockerfile("USER node", { from }), findings);
  });

  it.each<Row>([
    ["${BASE}", "FROM ${BASE}", ["2: The base image is `${BASE}`, which holds a build argument"]],
    ["$BASE", "FROM $BASE", [VARIABLE]],
    ["a default that is pinned", `FROM \${BASE:-${PINNED}}`, [VARIABLE]],
    ["a value used when set", `FROM \${BASE:+${PINNED}}`, [VARIABLE]],
    ["a variable in front of a digest", `FROM \${REGISTRY}/node@${DIGEST}`, [VARIABLE]],
    ["a variable for the tag", "FROM node:${TAG}", [VARIABLE]],
  ])("fails on an image that is a build argument: %s", (_title, from, findings) => {
    expectFindings(createDockerfile("USER node", { top: `ARG BASE=${PINNED}\n`, from }), findings);
  });

  it("accepts a build argument that the image does not use", () => {
    expectFindings(createDockerfile("ARG VERSION\nUSER node", { top: "ARG VERSION=1\n" }), []);
  });

  it.each<Row>([
    ["the name of an earlier stage", "FROM build\nUSER node", []],
    ["a name given in another letter case", "FROM other\nUSER node", []],
    ["a stage named in upper case", "FROM Build\nUSER node", [`3: The base image is \`Build\`, ${NO_DIGEST}`]],
    ["the number of a stage", "FROM 0\nUSER node", [`3: The base image is \`0\`, ${NO_DIGEST}`]],
    ["a stage with a tag", "FROM build:latest\nUSER node", [NO_DIGEST]],
    ["a name before its stage", `FROM later\nFROM ${PINNED} AS later\nFROM alpine:3 AS small\nFROM later\nUSER node`, ["3: The base image is `later`", "5: The base image is `alpine:3`"]],
  ])("reads a FROM that names a stage as Docker does: %s", (_title, lines, findings) => {
    expectFindings(createDockerfile(lines, { from: `FROM ${PINNED} AS build\nFROM ${PINNED} AS Other` }), findings);
  });

  it.each<Row>([
    ["COPY from an image by tag", "COPY --from=nginx:1 /etc/nginx /etc/nginx", [`3: This COPY takes files from the image \`nginx:1\`, ${NO_DIGEST}`]],
    ["COPY from an image in a variable", "COPY --from=${TOOLS} /bin/tool /bin/tool", ["3: This COPY takes files from the image `${TOOLS}`, which holds a build argument"]],
    ["COPY from a stage that does not exist", "COPY --from=7 /a /a", [NO_DIGEST]],
    ["COPY from the stage it is in, by name", "COPY --from=final /a /a", [NO_DIGEST]],
    ["COPY from the stage it is in, by number", "COPY --from=1 /a /a", [NO_DIGEST]],
    ["COPY from a later stage, an image to Docker", "COPY --from=later /a /a\nFROM scratch AS later", [NO_DIGEST]],
    ["ADD from an image by tag", "ADD --from=nginx:1 /a /a", ["3: This ADD takes files from the image `nginx:1`"]],
    ["a mount from an image by tag", "RUN --mount=type=bind,from=golang:1,target=/go true", [`3: This RUN takes files from the image \`golang:1\`, ${NO_DIGEST}`]],
    ["a mount from a number, an image there", "RUN --mount=type=cache,target=/c --mount=type=bind,FROM=0,target=/x true", ["3: This RUN takes files from the image `0`"]],
    ["a mount from the stage it is in", "RUN --mount=type=bind,from=final,target=/x true", [NO_DIGEST]],
  ])("holds every other image the build pulls to a digest: %s", (_title, lines, findings) => {
    expectFindings(createDockerfile(`${lines}\nUSER node`, { from: `FROM ${PINNED} AS build\nFROM ${PINNED} AS final` }), findings);
  });

  it.each<Row>([
    ["COPY from a stage by name", "COPY --from=build /a /a", []],
    ["COPY from a stage, its name in another case", "COPY --from=BUILD /a /a", []],
    ["COPY from a stage by number", "COPY --chown=1:1 --from=0 /a /a", []],
    ["COPY from a pinned image", `COPY --from=${PINNED} /a /a`, []],
    ["COPY from the build context", "COPY --chown=node:node . .", []],
    ["a mount from a stage", "RUN --mount=type=bind,from=build,target=/x true", []],
    ["a mount with no image", "RUN --mount=type=cache,target=/root/.cache true", []],
  ])("accepts %s", (_title, lines, findings) => {
    expectFindings(createDockerfile(`${lines}\nUSER node`, { from: `FROM ${PINNED} AS build\nFROM ${PINNED} AS final` }), findings);
  });
});

describe("the user the container runs as", () => {
  it("fails when the last stage sets none, at the line of its FROM", () => {
    expectFindings(CLEAN.replace("USER node\n", ""), [`2: ${NO_USER}`]);
  });

  it.each(["root", "0", "0:0", "root:root", "00", "root:1000"])("fails when the last stage ends as USER %s", (user) => {
    expectFindings(CLEAN.replace("USER node", `USER ${user}`), [`6: The last stage ends as \`USER ${user}\`, ${ROOT}`]);
  });

  it.each(["${APP_USER}", "$APP_USER", "${APP_USER:-node}", '"root"', "'root'", "r\\oot", "+0", "-0", "node extra", "node # the user", '""'])(
    "fails on USER %s, which may be root",
    (user) => {
      expectFindings(CLEAN.replace("USER node", `USER ${user}`), [`6: The last stage ends as \`USER ${user}\`, ${UNKNOWN_USER}`]);
    },
  );

  it.each(["node", "1000", "1000:0", "rootless", "app:app", "_apt", "10001:10001", "nobody"])("accepts USER %s", (user) => {
    expectFindings(CLEAN.replace("USER node", `USER ${user}`), []);
  });

  it("judges the last USER of the last stage: root for the build and another user after it passes", () => {
    expectFindings(CLEAN.replace("USER node", "USER root\nRUN chown -R node /app\nUSER node"), []);
    expectFindings(CLEAN.replace("USER node", "USER node\nUSER root"), ["7: The last stage ends as `USER root`"]);
  });

  it.each<Row>([
    ["an outside image starts as root", `USER node\nFROM ${PINNED}\nCOPY --from=base /app /app`, [`3: ${NO_USER}`]],
    ["a stage starts as its base stage's user", "USER node\nFROM base\nRUN true", []],
    ["and so through two stages", "USER node\nFROM base AS mid\nFROM mid", []],
    ["a base stage's root is its child's root", "USER root\nFROM base\nRUN true", [`2: The last stage ends as \`USER root\` (set in a stage this one is built from, at line 2), ${ROOT}`]],
    ["a base stage's variable is its child's", "USER $APP\nFROM base", [`2: The last stage ends as \`USER $APP\` (set in a stage this one is built from, at line 2), ${UNKNOWN_USER}`]],
    ["a base stage with no user leaves none", "RUN true\nFROM base", [`3: ${NO_USER}`]],
    ["the child's own USER comes after", "USER root\nFROM base\nUSER node", []],
    ["only the base stage counts", `USER node\nFROM ${PINNED} AS other\nFROM other`, [`4: ${NO_USER}`]],
  ])("reads the user across stages: %s", (_title, lines, findings) => {
    expectFindings(createDockerfile(lines, { from: `FROM ${PINNED} AS base` }), findings);
  });

  it.each<Row>([
    ["it does not set this stage's user", "ONBUILD USER node", [`1: ${NO_USER}`]],
    ["nor take it away", "USER node\nONBUILD USER root", []],
    ["it acts in the stage built from this one", "USER node\nONBUILD USER root\nFROM base", [`3: The last stage ends as \`USER root\` (set in a stage this one is built from, at line 3), ${ROOT}`]],
    ["and there it can set a user that passes", "USER root\nonbuild user node\nFROM base", []],
    ["the last one of a stage counts", "ONBUILD USER node\nONBUILD USER root\nFROM base", ["3: The last stage ends as `USER root`"]],
    ["it does not act two stages on", "USER node\nONBUILD USER root\nFROM base AS mid\nUSER node\nFROM mid", []],
  ])("reads ONBUILD USER as Docker runs it: %s", (_title, lines, findings) => {
    expectFindings(createDockerfile(lines, { from: `FROM ${PINNED} AS base` }), findings);
  });
});

describe("a package installed outside a lockfile", () => {
  it.each([
    ["npm install -g corepack@0.35.0", "npm install -g"],
    ["npm i --global corepack", "npm install -g"],
    ["apt-get update && npm install typescript -g", "npm install -g"],
    ["npm -g install typescript", "npm install -g"],
    ["npm --global=true add typescript", "npm install -g"],
    ["npm install typescript --location=global", "npm install -g"],
    ["npm install --location global typescript", "npm install -g"],
    ["/usr/local/bin/npm isntall -g typescript", "npm install -g"],
    ['"npm" install "-g" typescript', "npm install -g"],
    ["n\\pm install -g typescript", "npm install -g"],
    ["sh -c 'npm install -g typescript'", "npm install -g"],
    ["echo $(npm install -g typescript)", "npm install -g"],
    ["pnpm add -g turbo", "pnpm add -g"],
    ["pnpm --global install turbo", "pnpm add -g"],
    ["bun add --global turbo", "bun add -g"],
    ["yarn global add turbo", "yarn global add"],
    ["npx turbo prune", "npx"],
    ["pnpx turbo prune", "pnpx"],
    ["bunx turbo prune", "bunx"],
    ["pnpm dlx turbo prune", "dlx"],
    ["yarn dlx turbo prune", "dlx"],
    ["npm exec turbo prune", "npm exec"],
    ["bun x turbo prune", "bun x"],
    ['["npm", "install", "-g", "corepack"]', "npm install -g"],
    ['["npx", "turbo"]', "npx"],
  ])("fails on RUN %s", (command, what) => {
    expectFindings(CLEAN.replace("RUN pnpm install --frozen-lockfile", `RUN ${command}`), [`5: ${INSTALL} (${what}).`]);
  });

  it.each([
    "npm ci",
    "npm install",
    "pnpm install --frozen-lockfile",
    "npm install && echo -g",
    "npm ls -g",
    "npm run build -- -g",
    "pnpm --filter @app/server exec tsc",
    "yarn add turbo",
    "yarn global list",
    '["npm", "ci"]',
    '["pnpm", "install", "--frozen-lockfile"]',
  ])("accepts RUN %s", (command) => {
    expectFindings(CLEAN.replace("RUN pnpm install --frozen-lockfile", `RUN ${command}`), []);
  });

  it.each<Row>([
    ["several lines, a comment in them", "RUN apt-get update \\\n    # the tool\n\n    && npm install \\\n       -g corepack", [`2: ${INSTALL} (npm install -g).`]],
    ["a word cut in two by a line end", "RUN np\\\nm install -g corepack", [`2: ${INSTALL} (npm install -g).`]],
    ["the body of a heredoc", "RUN <<EOF\nset -e\nnpm install -g corepack\nEOF", [`2: ${INSTALL} (npm install -g).`]],
    ["a heredoc that drops its tabs", "RUN <<-EOF\n\tnpx turbo\n\tEOF", [`2: ${INSTALL} (npx).`]],
    ["a heredoc fed to a shell", "RUN sh <<'SCRIPT'\npnpm dlx turbo\nSCRIPT", [`2: ${INSTALL} (dlx).`]],
    ["the second heredoc of a line", "RUN cat <<A <<B\nset -e\nA\nyarn global add turbo\nB", [`2: ${INSTALL} (yarn global add).`]],
    ["a command that goes on in the body", "RUN <<EOF\nnpm install \\\n  -g corepack\nEOF", [`2: ${INSTALL} (npm install -g).`]],
    ["ONBUILD RUN, one build later", "ONBUILD RUN npx turbo", [`2: ${INSTALL} (npx).`]],
    ["two kinds in one RUN, once each", "RUN npx a && npx b && npm i -g c", [`2: ${INSTALL} (npx).`, `2: ${INSTALL} (npm install -g).`]],
  ])("reads the command as Docker runs it: %s", (_title, lines, findings) => {
    expectFindings(createDockerfile(`${lines}\nUSER node`), findings);
  });

  it.each<Row>([
    ["a file written by COPY, which is not run", "COPY <<EOF /usr/local/bin/setup\nnpm install -g corepack\nEOF", []],
    ["a comment in a heredoc's body", "RUN <<EOF\n  # npx would fetch it; the lockfile has it\nnpm ci\nEOF", []],
    ["CMD, which runs in the container", 'CMD ["npx", "serve"]', []],
  ])("accepts %s", (_title, lines, findings) => {
    expectFindings(createDockerfile(`${lines}\nUSER node`), findings);
  });
});

describe("reading a Dockerfile", () => {
  it("drops comments and blank lines, upper-cases the keyword, and keeps the line each instruction starts on", () => {
    expect(parseDockerfile("# syntax=docker/dockerfile:1\n\nfrom node AS a\r\n  run --network=none echo \\\n  two\nONBUILD copy --from=a /x /y\n")).toEqual({
      instructions: [
        { keyword: "FROM", flags: [], args: "node AS a", line: 3, onbuild: false, heredocs: [] },
        { keyword: "RUN", flags: ["--network=none"], args: "echo   two", line: 4, onbuild: false, heredocs: [] },
        { keyword: "COPY", flags: ["--from=a"], args: "/x /y", line: 6, onbuild: true, heredocs: [] },
      ],
    });
  });

  it("keeps the body of a heredoc out of the instructions, and the line of the instruction after it", () => {
    expect(parseDockerfile("RUN <<EOF 3<<-'B'\nUSER a\n  EOF\nEOF\n\tFROM x\n\t\tB\nUSER b")).toEqual({
      instructions: [
        {
          keyword: "RUN",
          flags: [],
          args: "<<EOF 3<<-'B'",
          line: 1,
          onbuild: false,
          heredocs: [
            { name: "EOF", body: "USER a\n  EOF" },
            { name: "B", body: "\tFROM x" },
          ],
        },
        { keyword: "USER", flags: [], args: "b", line: 7, onbuild: false, heredocs: [] },
      ],
    });
  });

  it("gives a file it cannot read as Docker does no instructions, and the line and the reason", () => {
    expect(parseDockerfile("FROM node\nUSER node\nEOF\n")).toEqual({
      instructions: [],
      unreadable: { line: 3, message: expect.stringContaining("Docker knows no instruction `EOF`") },
    });
  });

  it.each<Row>([
    ["a keyword in mixed case", "UsEr root", ["2: The last stage ends as `USER root`"]],
    ["a keyword cut in two by a line end", "USER node\nUS\\\nER root", ["3: The last stage ends as `USER root`"]],
    ["two backslashes, which join nothing", "USER node\nRUN echo a\\\\\nUSER root", ["4: The last stage ends as `USER root`"]],
    ["blanks after the backslash, which still joins", "USER root\nRUN echo \\ \t\nUSER node", ["2: The last stage ends as `USER root`"]],
    ["a comment and a blank line in an instruction", "USER node\nRUN echo \\\n  # USER node\n\n  done\nUSER root", ["7: The last stage ends as `USER root`"]],
    ["a comment that ends in a backslash", "USER node\n# a note \\\nUSER root", ["4: The last stage ends as `USER root`"]],
    ["USER in the body of a COPY heredoc", "COPY <<EOF /etc/motd\nUSER node\nEOF", [`1: ${NO_USER}`]],
    ["USER after a heredoc that only looks open", "USER node\nRUN <<EOF\nEOF \nUSER node\nEOF\nUSER root", ["7: The last stage ends as `USER root`"]],
    ["USER with a tab after it", "USER\troot", ["2: The last stage ends as `USER root`"]],
  ])("reads what Docker reads, and fails: %s", (_title, lines, findings) => {
    expectFindings(createDockerfile(lines), findings);
  });

  it.each<Row>([
    ["a keyword cut in two by a line end", "US\\\nER node", []],
    ["two backslashes, which join nothing", "USER root\nRUN echo a\\\\\nUSER node", []],
    ["blanks after the backslash, which still joins", "USER node\nRUN echo \\  \nUSER root", []],
    ["USER and FROM in the body of a RUN heredoc", "RUN <<EOF\nUSER root\nFROM node:latest\nEOF\nUSER node", []],
    ["a tab before the name, in a heredoc that keeps tabs", "RUN <<EOF\n\tEOF\nUSER root\nEOF\nUSER node", []],
    ["a heredoc in quotes that drops its tabs", 'RUN <<-"EOF"\n\tUSER root\n\t\tEOF\nUSER node', []],
    ["RUN, CMD and ENTRYPOINT with nothing after them", "RUN\nCMD\nENTRYPOINT\nUSER node", []],
    ["a heredoc with no body", "COPY <<EOF /srv/empty\nEOF\nUSER node", []],
    ["two heredocs on one line", "COPY <<one.txt <<two.txt /srv/\nUSER root\none.txt\nUSER root\ntwo.txt\nUSER node", []],
    ["a heredoc after ONBUILD RUN", "USER node\nONBUILD RUN <<EOF\nUSER root\nEOF", []],
    ["a list that holds a heredoc's sign", 'USER node\nRUN ["echo", "<<EOF"]\nUSER node', []],
  ])("reads what Docker reads, and passes: %s", (_title, lines, findings) => {
    expectFindings(createDockerfile(lines), findings);
  });

  it("reads a last line that ends in a backslash as an instruction, with no line end after it", () => {
    expectFindings(`FROM ${PINNED}\nUSER node\nUSER root \\`, ["3: The last stage ends as `USER root`"]);
    expectFindings(`FROM ${PINNED}\nUSER node\nRUN npm install -g corepack \\`, [`3: ${INSTALL} (npm install -g).`]);
    expectFindings(`FROM ${PINNED}\nUSER node`, []);
  });

  it.each<RowWithTop>([
    ["escape changes what joins lines", "# escape=`\n", "USER node\nRUN echo \\\nUSER root", ["5: The last stage ends as `USER root`"]],
    ["in upper case, with blanks", "  #ESCAPE =  `  \n", "USER node\nRUN echo \\\nUSER root", ["5: The last stage ends as `USER root`"]],
    ["after syntax, check and a byte order mark", "\uFEFF# syntax=docker/dockerfile:1\n# check=skip=all\n# escape=`\n", "USER node\nRUN echo \\\nUSER root", ["7: The last stage ends as `USER root`"]],
    ["after a comment it is a comment", "# the image\n# escape=`\n", "USER node\nRUN echo `\nUSER root", ["6: The last stage ends as `USER root`"]],
    ["after a blank line it is a comment", "\n# escape=`\n", "USER node\nRUN echo `\nUSER root", ["6: The last stage ends as `USER root`"]],
    ["after a comment with a key Docker has not", "# shell=bash\n# escape=`\n", "USER node\nRUN echo `\nUSER root", ["6: The last stage ends as `USER root`"]],
    ["given twice", "# escape=`\n# Escape=`\n", "USER node", ["2: The parser directive `escape` is given twice"]],
    ["a character Docker does not take", "# escape=^\n", "USER node", ["1: `# escape=^` names an escape character Docker does not take"]],
    ["another frontend", "# syntax=ghcr.io/acme/frontend:1\n", "USER node", ["1: `# syntax=ghcr.io/acme/frontend:1` hands this file to another frontend"]],
    ["a frontend named almost like Docker's", "# syntax=docker/dockerfile.evil/x\n", "USER node", ["hands this file to another frontend"]],
  ])("reads a parser directive, and fails: %s", (_title, top, lines, findings) => {
    expectFindings(createDockerfile(lines, { top }), findings);
  });

  it.each<RowWithTop>([
    ["escape as a backtick joins on a backtick", "# escape=`\n", "RUN echo one `\n  && echo two\nUSER node", []],
    ["escape as a backtick leaves a backslash", "# escape=`\n", "USER root\nRUN dir C:\\\nUSER node", []],
    ["escape as the backslash it already is", "# escape=\\\n", "RUN echo \\\n  USER root\nUSER node", []],
    ["Docker's frontend by tag", "# syntax=docker/dockerfile:1\n", "USER node", []],
    ["Docker's frontend by digest", `#syntax = docker.io/docker/dockerfile:1.7@${DIGEST}\n`, "USER node", []],
    ["check", "# check=skip=all;error=true\n", "USER node", []],
    ["a byte order mark at the start", "\uFEFF", "USER node", []],
  ])("reads a parser directive, and passes: %s", (_title, top, lines, findings) => {
    expectFindings(createDockerfile(lines, { top }), findings);
  });

  it.each<Row>([
    ["a word Docker does not know", "FOO bar\nUSER node", ["2: Docker knows no instruction `FOO`"]],
    ["an instruction with nothing after it", "WORKDIR\nUSER node", ["2: This WORKDIR has nothing after it"]],
    ["USER with nothing after it", "USER node\nUSER", ["3: This USER has nothing after it"]],
    ["COPY with flags and nothing after them", "COPY --from=0\nUSER node", ["2: This COPY has nothing after it"]],
    ["a line of a script outside a heredoc", "RUN echo one\n  && echo two\nUSER node", ["3: Docker knows no instruction `&&`"]],
    ["a heredoc with no space before it", "RUN cat<<EOF\nUSER node\nEOF", ["2: This RUN holds `<<`, and the word `cat<<EOF` makes it unclear"]],
    ["a heredoc sign inside quotes", 'RUN echo "a <<EOF b"\nUSER root\nCOPY <<EOF /x\nEOF\nUSER node', ['2: This RUN holds `<<`, and the word `"a` makes it unclear']],
    ["a heredoc name with a blank in quotes", 'RUN <<"LABEL a=b"\nUSER root\nLABEL a=b\nUSER node', ['2: This RUN holds `<<`, and the word `<<"LABEL` makes it unclear']],
    ["a heredoc sign inside single quotes", "RUN echo 'a <<EOF b'\nUSER root\nCOPY <<EOF /x\nEOF\nUSER node", ["2: This RUN holds `<<`, and the word `'a` makes it unclear"]],
    ["a heredoc sign inside a variable's braces", "RUN echo ${X:-a <<EOF b}\nUSER node\nEOF", ["2: This RUN holds `<<`, and the word `${X:-a` makes it unclear"]],
    ["a heredoc after a backslash", "RUN echo a\\ <<EOF\nUSER node\nEOF", ["2: This RUN holds `<<`, and the word `a\\` makes it unclear"]],
    ["a shift, a heredoc to Docker", "RUN echo $((1 << 2))\nUSER node", ["2: This RUN holds `<<`, and the word `<<` makes it unclear"]],
    ["a heredoc after a list", 'RUN ["true"] <<EOF\nUSER root\nEOF\nUSER node', ['2: This RUN holds `<<`, and the word `["true"]` makes it unclear']],
    ["a heredoc named like an instruction", "RUN <<cmd\nUSER root\ncmd\nUSER node", ["2: The heredoc is named `cmd`, which is an instruction"]],
    ["a heredoc that never ends", "RUN <<EOF\nUSER node\n EOF", ["2: The heredoc `EOF` never ends"]],
    ["a heredoc whose end has a blank after it", "COPY <<EOF /x\nEOF \nUSER node", ["2: The heredoc `EOF` never ends"]],
    ["a heredoc after CMD, which takes none", "CMD <<EOF\nUSER node\nEOF", ["4: Docker knows no instruction `EOF`"]],
    ["a list that holds a number", "RUN [1, 2]\nUSER node", ["2: This RUN is a JSON list that holds something other than text"]],
    ["ONBUILD ONBUILD", "ONBUILD ONBUILD RUN true\nUSER node", ["2: Docker refuses ONBUILD after ONBUILD"]],
    ["ONBUILD FROM", "ONBUILD FROM node\nUSER node", ["2: Docker refuses FROM after ONBUILD"]],
    ["ONBUILD and a word Docker does not know", "ONBUILD USE node\nUSER node", ["2: Docker knows no instruction `USE`"]],
    ["a flag in quotes", 'COPY --from="nginx:1" /a /a\nUSER node', ['2: The flag `--from="nginx:1"` holds a quote or the escape character']],
    ["a flag with a backslash", "COPY --from=ng\\inx /a /a\nUSER node", ["2: The flag `--from=ng\\inx` holds a quote or the escape character"]],
    ["a NUL byte", "USER node\0", ["2: This line holds the character U+0000"]],
    ["a NUL byte inside a keyword", "US\0ER root\nUSER node", ["2: This line holds the character U+0000"]],
    ["a no-break space before an instruction", "USER node\n\u00a0USER root", ["3: This line holds the character U+00A0"]],
    ["a byte order mark not at the start", "\uFEFFUSER root\nUSER node", ["2: This line holds the character U+FEFF"]],
    ["a carriage return inside a line", "USER node\rUSER root", ["2: This line holds the character U+000D"]],
    ["a line separator", "RUN echo\u2028USER node", ["2: This line holds the character U+2028"]],
    ["a form feed", "USER\fnode", ["2: This line holds the character U+000C"]],
    ["a byte that is not UTF-8", "USER node\ufffd", ["2: This line holds the character U+FFFD"]],
  ])("fails a file Docker would refuse or read another way: %s", (_title, lines, findings) => {
    const result = findingsOf(createDockerfile(lines));

    expect(result).toEqual(findings.map((finding) => expect.stringContaining(finding)));
    expect(result[0]).toContain(NOT_JUDGED);
  });

  it.each<Row>([
    ["a pass", "USER node", []],
    ["a root user", "USER node\nUSER root", ["3: The last stage ends as `USER root`"]],
    ["a continued line", "USER node\nUS\\\nER root", ["3: The last stage ends as `USER root`"]],
    ["the end of a heredoc", "RUN <<EOF\nUSER root\nEOF\nUSER node", []],
    ["a comment in a continued line", "RUN echo \\\n# USER node\n  hi\nUSER 0", ["5: The last stage ends as `USER 0`"]],
  ])("reads Windows line ends: %s", (_title, lines, findings) => {
    const dockerfile = createDockerfile(lines).replaceAll("\n", "\r\n");

    expect(dockerfile).toContain("\r\n");
    expectFindings(dockerfile, findings);
  });

  it.each<Row>([
    ["an empty file", "", ["1: There is no FROM line"]],
    ["a file of comments", "# nothing yet\n\n", ["1: There is no FROM line"]],
    ["a file with ARG and no FROM", "ARG BASE=node\n", ["1: There is no FROM line"]],
    ["an instruction before the first FROM", `RUN echo\nFROM ${PINNED}\nUSER node\n`, ["1: This RUN stands before the first FROM"]],
    ["ONBUILD ARG before the first FROM", `ONBUILD ARG A\nFROM ${PINNED}\nUSER node\n`, ["1: This ARG stands before the first FROM"]],
    ["no FROM, and its other finding with it", "RUN echo\n", ["1: This RUN stands before the first FROM", "1: There is no FROM line"]],
  ])("fails a file that does not build: %s", (_title, dockerfile, findings) => {
    expectFindings(dockerfile, findings);
  });

  it("accepts ARG before the first FROM", () => {
    expectFindings(`ARG VERSION=26\nARG OTHER\nFROM ${PINNED}\nUSER node\n`, []);
  });
});

describe("which files are Dockerfiles", () => {
  it("finds them by name in any letter case and in any folder but node_modules and .git", () => {
    const root = createFolder({
      Dockerfile: CLEAN,
      "packages/server/Dockerfile": CLEAN,
      "packages/server/Dockerfile.dev": CLEAN,
      "packages/web/dockerfile": CLEAN,
      "packages/api/DOCKERFILE.PROD": CLEAN,
      "deploy/worker.Dockerfile": CLEAN,
      "deploy/Containerfile": CLEAN,
      "deploy/podman/containerfile.dev": CLEAN,
      "deploy/podman/api.Containerfile": CLEAN,
      "docs/Dockerfile.md.txt": "",
      "docs/NotADockerfile": "",
      "docs/Dockerfiles": "",
      "docs/Dockerfile.dockerignore": "node_modules",
      "node_modules/pkg/Dockerfile": "FROM node",
      ".git/Dockerfile": "FROM node",
      "packages/server/node_modules/pkg/Dockerfile": "FROM node",
      "packages/server/dist/Dockerfile": CLEAN,
      "tools/arch/Dockerfile": CLEAN,
      "reports/Dockerfile": CLEAN,
    });

    expect(listDockerfiles(root)).toEqual([
      "Dockerfile",
      "deploy/Containerfile",
      "deploy/podman/api.Containerfile",
      "deploy/podman/containerfile.dev",
      "deploy/worker.Dockerfile",
      "docs/Dockerfile.md.txt",
      "packages/api/DOCKERFILE.PROD",
      "packages/server/Dockerfile",
      "packages/server/Dockerfile.dev",
      "packages/server/dist/Dockerfile",
      "packages/web/dockerfile",
      "reports/Dockerfile",
      "tools/arch/Dockerfile",
    ]);
  });

  it("names the file and the line of each finding, across files", () => {
    const root = createFolder({ Dockerfile: CLEAN, "packages/server/Dockerfile": CLEAN.replace(PINNED, "node:26") });
    const result = checkDockerfiles(root);

    expect(result.files).toBe(2);
    expect(formatResult(result).split("\n").slice(0, 2)).toEqual(["FAIL dockerfiles (1)", "  packages/server/Dockerfile:2"]);
  });

  it("follows a link named like a Dockerfile, and judges what it points at", () => {
    const root = createFolder({ "images/server.txt": CLEAN.replace(PINNED, "node:26"), "images/clean.txt": CLEAN });

    symlinkSync("images/server.txt", join(root, "Dockerfile"));
    symlinkSync("clean.txt", join(root, "images/Dockerfile"));

    const result = checkDockerfiles(root);

    expect(result.files).toBe(2);
    expect(result.findings).toEqual([{ file: "Dockerfile", line: 2, message: expect.stringContaining("The base image is `node:26`") }]);
  });

  it.each([
    ["a link to nothing", "missing.txt", "This Dockerfile could not be read, so it was not judged, and a file that is not judged has not passed: ENOENT"],
    ["a link to a folder", "images", "This is named like a Dockerfile and is not a file"],
  ])("fails on %s", (_title, target, message) => {
    const root = createFolder({ "images/readme.txt": "" });

    symlinkSync(target, join(root, "Dockerfile"));

    expect(checkDockerfiles(root)).toEqual({ gate: "dockerfiles", findings: [{ file: "Dockerfile", line: 1, message: expect.stringContaining(message) }], files: 1, images: 0 });
  });

  // Root reads a file whatever its mode, so as root this case would say nothing.
  it.skipIf(process.getuid?.() === 0)("fails on a Dockerfile it may not read, and still judges the others", () => {
    const root = createFolder({ Dockerfile: CLEAN, "server/Dockerfile": CLEAN.replace("USER node\n", "") });

    chmodSync(join(root, "Dockerfile"), 0o000);

    expect(checkDockerfiles(root).findings).toEqual([
      { file: "Dockerfile", line: 1, message: expect.stringContaining("could not be read, so it was not judged, and a file that is not judged has not passed: EACCES") },
      { file: "server/Dockerfile", line: 2, message: expect.stringContaining(NO_USER) },
    ]);
  });

  it("walks into a folder named like a Dockerfile, and not into a link to a folder", () => {
    const root = createFolder({ "Dockerfile/Dockerfile": CLEAN, "real/Dockerfile": CLEAN });

    symlinkSync("real", join(root, "linked"));
    mkdirSync(join(root, "Containerfile"));

    expect(listDockerfiles(root)).toEqual(["Dockerfile/Dockerfile", "real/Dockerfile"]);
  });
});

describe("the script", () => {
  const SCRIPT = "tools/ci-security/check-dockerfiles.mts";

  function runIn(files: Record<string, string>): { status: number | null; stdout: string } {
    const root = createFolder(files);

    cpSync(join(ADDON, "files/tools"), join(root, "tools"), { recursive: true });

    const { status, stdout } = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8" });

    return { status, stdout };
  }

  it("exits 0 with a SKIP line in a project with no Dockerfile", () => {
    expect(runIn({})).toEqual({ status: 0, stdout: "SKIP dockerfiles — the project has no Dockerfile, so there was nothing to check\n" });
  });

  it("exits 1 on a finding and 0 on none, judging the project it is installed in", () => {
    expect(runIn({ Dockerfile: CLEAN }).status).toBe(0);
    expect(runIn({ Dockerfile: CLEAN.replace("USER node\n", "") }).status).toBe(1);
  });

  it("exits 1 on a Dockerfile it cannot read as Docker does, and prints the line", () => {
    const { status, stdout } = runIn({ Dockerfile: CLEAN.replace("USER node", "USER node\nEOF") });

    expect(status).toBe(1);
    expect(stdout).toContain("FAIL dockerfiles (1)\n  Dockerfile:7\n    Docker knows no instruction `EOF`");
  });
});

/** A Dockerfile whose FROM is pinned and stands on the line after `top`, with `lines` after it. */
function createDockerfile(lines: string, { top = "", from = `FROM ${PINNED}` }: { top?: string; from?: string } = {}): string {
  return `${top}${from}\n${lines}\n`;
}
