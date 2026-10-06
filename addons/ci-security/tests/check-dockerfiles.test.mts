import { spawnSync } from "node:child_process";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkDockerfiles, formatResult, listDockerfiles, parseDockerfile } from "../files/tools/ci-security/check-dockerfiles.mts";
import { ADDON, createFolder } from "./support.mts";

const DIGEST = `sha256:${"ab12".repeat(16)}`;
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

function findingsOf(dockerfile: string): string[] {
  return checkDockerfiles(createFolder({ Dockerfile: dockerfile })).findings.map(({ line, message }) => `${line}: ${message}`);
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

  it("accepts the empty image and a stage of the same file as a base, by name or by number", () => {
    const stages = [
      `FROM --platform=linux/amd64 ${PINNED} AS build`,
      "RUN make",
      "FROM build AS test",
      "FROM 0 AS again",
      "FROM scratch",
      "COPY --from=build /app /app",
      "USER 1000",
      "",
    ].join("\n");
    const result = checkDockerfiles(createFolder({ Dockerfile: stages }));

    expect(result.findings).toEqual([]);
    expect(result.images).toBe(4);
  });
});

describe("the base image", () => {
  it("fails on a tag with no digest, and says how to get the digest for that image", () => {
    const [finding = ""] = findingsOf(CLEAN.replace(PINNED, "node:26-slim"));

    expect(finding).toContain("2: The base image is `node:26-slim`, with no digest.");
    expect(finding).toContain("`FROM node:26-slim@sha256:<digest>`");
    expect(finding).toContain("docker buildx imagetools inspect node:26-slim");
  });

  it("fails on no tag at all, on latest, and on a digest that is cut short", () => {
    for (const image of ["node", "node:latest", "ghcr.io/acme/base:1", `node:26@sha256:${"ab".repeat(31)}`]) {
      expect(findingsOf(CLEAN.replace(PINNED, image))).toEqual([expect.stringContaining(`The base image is \`${image}\`, with no digest.`)]);
    }
  });

  it("fails on an image that is a build argument, which cannot be checked", () => {
    expect(findingsOf(`ARG BASE=${PINNED}\n${CLEAN.replace(PINNED, "${BASE}")}`)).toEqual([
      expect.stringContaining("3: The base image is `${BASE}`, a build argument"),
    ]);
  });

  it("judges every stage, and a name is a stage only after the stage that has it", () => {
    const dockerfile = [`FROM later`, `FROM ${PINNED} AS later`, "FROM alpine:3 AS small", "FROM later", "USER node", ""].join("\n");

    expect(findingsOf(dockerfile).map((finding) => finding.split(",")[0])).toEqual(["1: The base image is `later`", "3: The base image is `alpine:3`"]);
  });
});

describe("the user the container runs as", () => {
  it("fails when the last stage sets none, at the line of its FROM", () => {
    expect(findingsOf(CLEAN.replace("USER node\n", ""))).toEqual([expect.stringContaining("2: The last stage sets no USER")]);
  });

  it("fails when the last stage ends as root, by name or by number", () => {
    for (const user of ["root", "0", "0:0", "root:root"]) {
      expect(findingsOf(CLEAN.replace("USER node", `USER ${user}`))).toEqual([expect.stringContaining(`6: The last stage ends as \`USER ${user}\``)]);
    }
  });

  it("judges the last USER of the last stage: root for the build and another user after it passes", () => {
    expect(findingsOf(CLEAN.replace("USER node", "USER root\nRUN chown -R node /app\nUSER node"))).toEqual([]);
    expect(findingsOf(CLEAN.replace("USER node", "USER node\nUSER root"))).toEqual([expect.stringContaining("7: The last stage ends as `USER root`")]);
  });

  it("does not count a USER of an earlier stage", () => {
    const dockerfile = [`FROM ${PINNED} AS build`, "USER node", `FROM ${PINNED}`, "COPY --from=build /app /app", ""].join("\n");

    expect(findingsOf(dockerfile)).toEqual([expect.stringContaining("3: The last stage sets no USER")]);
  });

  it("accepts a user that only starts like root", () => {
    expect(findingsOf(CLEAN.replace("USER node", "USER rootless"))).toEqual([]);
    expect(findingsOf(CLEAN.replace("USER node", "USER 1000:0"))).toEqual([]);
  });
});

describe("a package installed outside a lockfile", () => {
  it.each([
    ["npm install -g corepack@0.35.0", "npm install -g"],
    ["npm i --global corepack", "npm install -g"],
    ["apt-get update && npm install typescript -g", "npm install -g"],
    ["pnpm add -g turbo", "pnpm add -g"],
    ["yarn global add turbo", "yarn global add"],
    ["npx turbo prune", "npx"],
    ["pnpm dlx turbo prune", "dlx"],
  ])("fails on RUN %s", (command, what) => {
    expect(findingsOf(CLEAN.replace("RUN pnpm install --frozen-lockfile", `RUN ${command}`))).toEqual([
      expect.stringContaining(`5: This RUN installs a package outside a lockfile (${what}).`),
    ]);
  });

  it.each(["npm ci", "npm install", "pnpm install --frozen-lockfile", "npm install && echo -g", "pnpm --filter @app/server exec tsc"])(
    "accepts RUN %s",
    (command) => {
      expect(findingsOf(CLEAN.replace("RUN pnpm install --frozen-lockfile", `RUN ${command}`))).toEqual([]);
    },
  );

  it("reads a command that runs over several lines as one, at the line it starts on", () => {
    const dockerfile = CLEAN.replace("RUN pnpm install --frozen-lockfile", "RUN apt-get update \\\n    # the tool\n    && npm install \\\n       -g corepack");

    expect(findingsOf(dockerfile)).toEqual([expect.stringContaining("5: This RUN installs a package outside a lockfile (npm install -g).")]);
  });
});

describe("reading a Dockerfile", () => {
  it("drops comments and blank lines, upper-cases the keyword, and keeps the line each instruction starts on", () => {
    expect(parseDockerfile("# syntax=docker/dockerfile:1\n\nfrom node AS a\r\n  run echo \\\n  two\n")).toEqual([
      { keyword: "FROM", rest: "node AS a", line: 3 },
      { keyword: "RUN", rest: "echo two", line: 4 },
    ]);
  });

  it("says a file with no FROM is not a Dockerfile that builds", () => {
    expect(findingsOf("RUN echo\n")).toEqual([expect.stringContaining("1: There is no FROM line")]);
  });
});

describe("which files are Dockerfiles", () => {
  it("finds them by name anywhere in the project, and leaves installed and generated folders alone", () => {
    const root = createFolder({
      Dockerfile: CLEAN,
      "packages/server/Dockerfile": CLEAN,
      "packages/server/Dockerfile.dev": CLEAN,
      "deploy/worker.Dockerfile": CLEAN,
      "deploy/Containerfile": CLEAN,
      "docs/Dockerfile.md.txt": "",
      "docs/NotADockerfile": "",
      "node_modules/pkg/Dockerfile": "FROM node",
      "packages/server/dist/Dockerfile": "FROM node",
      "tools/arch/Dockerfile": "FROM node",
      "packages/server/tools/Dockerfile": CLEAN,
    });

    expect(listDockerfiles(root)).toEqual([
      "Dockerfile",
      "deploy/Containerfile",
      "deploy/worker.Dockerfile",
      "docs/Dockerfile.md.txt",
      "packages/server/Dockerfile",
      "packages/server/Dockerfile.dev",
      "packages/server/tools/Dockerfile",
    ]);
  });

  it("names the file and the line of each finding, across files", () => {
    const root = createFolder({ Dockerfile: CLEAN, "packages/server/Dockerfile": CLEAN.replace(PINNED, "node:26") });
    const result = checkDockerfiles(root);

    expect(result.files).toBe(2);
    expect(formatResult(result).split("\n").slice(0, 2)).toEqual(["FAIL dockerfiles (1)", "  packages/server/Dockerfile:2"]);
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
});
