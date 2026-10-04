// Builds the client and serves the build, for the runtime audit.
//
// The audit always starts its own server, on a port nobody is using, and stops
// it when it is done. It never attaches to a server that is already running:
// that one may be serving other code, or another project.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export class ServerError extends Error {}

export interface ClientServer {
  url: string;
  stop(): Promise<void>;
}

const READY_TIMEOUT_MS = 30_000;

/** The workspace package to audit: the one given, or the only one Vite serves. */
export function findClient(root: string, requested?: string): string {
  if (requested !== undefined) {
    if (!existsSync(join(root, requested, "index.html"))) {
      throw new ServerError(`${requested} has no index.html: it is not a client Vite can serve`);
    }

    return requested;
  }

  const packages = join(root, "packages");
  const clients = (existsSync(packages) ? readdirSync(packages) : [])
    .map((name) => `packages/${name}`)
    .filter((path) => existsSync(join(root, path, "index.html")) && dependsOnVite(join(root, path, "package.json")));

  if (clients.length !== 1) {
    throw new ServerError(
      clients.length === 0
        ? "found no client: no package under packages/ has an index.html and depends on vite"
        : `found ${clients.length} clients (${clients.join(", ")}): pass --client <path> to choose one`,
    );
  }

  return clients[0] as string;
}

function dependsOnVite(manifest: string): boolean {
  if (!existsSync(manifest)) {
    return false;
  }

  const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync(manifest, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  return "vite" in dependencies || "vite" in devDependencies;
}

/**
 * Builds the client for the in-browser simulator into a temporary folder and
 * serves it. The project's own `dist` is not touched.
 */
export async function startClient(root: string, client: string): Promise<ClientServer> {
  const directory = join(root, client);
  const vite = resolveVite(directory);
  const output = mkdtempSync(join(tmpdir(), "perf-audit-"));
  // An empty server URL is how the starter's composition root picks the simulator.
  const env = { ...process.env, VITE_SERVER_URL: "" };

  const build = spawnSync(process.execPath, [vite, "build", "--outDir", output, "--emptyOutDir", "--logLevel", "warn"], {
    cwd: directory,
    env,
    encoding: "utf8",
  });

  if (build.status !== 0) {
    rmSync(output, { recursive: true, force: true });

    throw new ServerError(`the client did not build:\n${build.stdout}${build.stderr}`.trim());
  }

  const port = await findFreePort();
  const url = `http://127.0.0.1:${port}`;
  // `--strictPort`: if something took the port in the meantime, Vite exits
  // and the audit stops. It never ends up talking to someone else's server.
  const child = spawn(
    process.execPath,
    [vite, "preview", "--outDir", output, "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    log += chunk.toString();
  });

  async function stop(): Promise<void> {
    await stopProcess(child);
    rmSync(output, { recursive: true, force: true });
  }

  try {
    // Vite prints the address once it is listening. Waiting for that line, and
    // not only for an answer on the port, is what proves the answer is ours.
    await waitUntilServing(url, child, () => log.replace(/\u001b\[[0-9;]*m/g, "").includes(`:${port}`));
  } catch (error) {
    await stop();

    throw new ServerError(`${error instanceof Error ? error.message : String(error)}\n${log}`.trim());
  }

  return { url, stop };
}

/** The Vite the client itself depends on, run by this Node directly: no wrapper process to orphan. */
function resolveVite(directory: string): string {
  try {
    const manifest = createRequire(join(directory, "package.json")).resolve("vite/package.json");
    const { bin } = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: string | Record<string, string> };
    const entry = typeof bin === "string" ? bin : bin?.vite;

    if (entry === undefined) {
      throw new ServerError("vite's package.json names no executable");
    }

    return join(dirname(manifest), entry);
  } catch (error) {
    throw new ServerError(
      `cannot find vite from ${directory}: run pnpm install (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
    );
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();

    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();

      probe.close(() => {
        if (address !== null && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new ServerError("could not find a free port"));
        }
      });
    });
  });
}

async function waitUntilServing(url: string, child: ChildProcess, announced: () => boolean): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new ServerError(`the server stopped before it served anything (exit ${child.exitCode})`);
    }

    try {
      if (announced() && (await fetch(url)).ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }

  throw new ServerError(`the server did not answer on ${url} within ${READY_TIMEOUT_MS / 1000} s`);
}

function stopProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();

      return;
    }

    const force = setTimeout(() => child.kill("SIGKILL"), 5000);

    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
