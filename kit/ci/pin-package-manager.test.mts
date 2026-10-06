import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PinError, pinPackageManager, type ReadRelease } from "./pin-package-manager.mts";

/** 64 bytes, so a sha512: every byte is 0xab. */
const HEX = "ab".repeat(64);
const INTEGRITY = `sha512-${Buffer.from(HEX, "hex").toString("base64")}`;

describe("pinning the package manager", () => {
  it("prints the version package.json names with the registry's hash, in hex, and writes nothing", async () => {
    const root = createRoot('{\n  "name": "fx",\n  "packageManager": "pnpm@12.6.0"\n}\n');
    const registry = createRegistry();

    const pinned = await pinPackageManager({ root, write: false, readRelease: registry.readRelease });

    expect(pinned).toEqual({ packageManager: `pnpm@12.6.0+sha512.${HEX}`, written: false });
    expect(registry.asked).toEqual(["pnpm@12.6.0"]);
    expect(readManifest(root)).toBe('{\n  "name": "fx",\n  "packageManager": "pnpm@12.6.0"\n}\n');
  });

  it("writes the one line with --write, and leaves the rest of the file as it was", async () => {
    const root = createRoot('{\n    "name": "fx",\n    "packageManager": "pnpm@12.6.0",\n    "scripts": {}\n}\n');

    const pinned = await pinPackageManager({ root, write: true, readRelease: createRegistry().readRelease });

    expect(pinned.written).toBe(true);
    expect(readManifest(root)).toBe(`{\n    "name": "fx",\n    "packageManager": "pnpm@12.6.0+sha512.${HEX}",\n    "scripts": {}\n}\n`);
  });

  it("moves to the version it is given, replacing the old hash", async () => {
    const root = createRoot(`{\n  "packageManager": "pnpm@12.6.0+sha512.${"0".repeat(128)}"\n}\n`);
    const registry = createRegistry();

    await pinPackageManager({ root, wanted: "pnpm@12.7.1", write: true, readRelease: registry.readRelease });

    expect(registry.asked).toEqual(["pnpm@12.7.1"]);
    expect(readManifest(root)).toBe(`{\n  "packageManager": "pnpm@12.7.1+sha512.${HEX}"\n}\n`);
  });

  it("adds the field as the first one when package.json has none", async () => {
    const root = createRoot('{\n  "name": "fx"\n}\n');

    await pinPackageManager({ root, wanted: "pnpm@12.6.0", write: true, readRelease: createRegistry().readRelease });

    expect(readManifest(root)).toBe(`{\n  "packageManager": "pnpm@12.6.0+sha512.${HEX}",\n  "name": "fx"\n}\n`);
  });

  it("says it wrote nothing when the field already has that hash", async () => {
    const root = createRoot(`{\n  "packageManager": "pnpm@12.6.0+sha512.${HEX}"\n}\n`);

    expect((await pinPackageManager({ root, write: true, readRelease: createRegistry().readRelease })).written).toBe(false);
  });

  it("refuses a version that is not exact, and a project that names none", async () => {
    const root = createRoot('{\n  "name": "fx"\n}\n');
    const { readRelease } = createRegistry();

    await expect(pinPackageManager({ root, wanted: "pnpm@latest", write: false, readRelease })).rejects.toThrow(
      new PinError('"pnpm@latest" is not a name and an exact version: write it as pnpm@12.6.0'),
    );
    await expect(pinPackageManager({ root, write: false, readRelease })).rejects.toThrow(/names no package manager with an exact version/);
  });

  it("refuses when the registry has no sha512 for the release, and writes nothing", async () => {
    const root = createRoot('{\n  "packageManager": "pnpm@12.6.0"\n}\n');

    for (const release of [{}, { dist: { integrity: "sha1-abcd" } }, { dist: { integrity: "sha512-YWJj" } }, null]) {
      await expect(pinPackageManager({ root, write: true, readRelease: () => Promise.resolve(release) })).rejects.toThrow(
        new PinError("the registry gave no sha512 hash for pnpm@12.6.0, so there is nothing to pin it with"),
      );
    }

    expect(readManifest(root)).toBe('{\n  "packageManager": "pnpm@12.6.0"\n}\n');
  });

  it("refuses outside a project", async () => {
    await expect(pinPackageManager({ root: mkdtempSync(join(tmpdir(), "pin-none-")), write: false })).rejects.toThrow(/run this in the project root/);
  });
});

function createRoot(manifest: string): string {
  const root = mkdtempSync(join(tmpdir(), "pin-manager-"));

  writeFileSync(join(root, "package.json"), manifest);

  return root;
}

function readManifest(root: string): string {
  return readFileSync(join(root, "package.json"), "utf8");
}

interface FakeRegistry {
  readRelease: ReadRelease;
  /** Every release asked for, as `name@version`. */
  asked: string[];
}

/** A registry that knows one hash, the same for every release. */
function createRegistry(): FakeRegistry {
  const asked: string[] = [];

  return {
    asked,
    readRelease: (name, version) => {
      asked.push(`${name}@${version}`);

      return Promise.resolve({ dist: { integrity: INTEGRITY } });
    },
  };
}
