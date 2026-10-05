// Fixture factories shared by the ci-security add-on's tests. Nothing here
// touches the network: a download is a function that returns bytes.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Download, Extract } from "../files/tools/ci-security/lib/install.mts";
import type { Pin } from "../files/tools/ci-security/lib/pins.mts";

export const ADDON = join(import.meta.dirname, "..");

/** What the pretend release asset holds. */
export const ARCHIVE = Buffer.from("the bytes of the release archive");

/** What somebody else's file holds: same name, other bytes. */
export const TAMPERED = Buffer.from("the bytes of another archive");

export const PLATFORM = "linux-x64";

export const ASSET_URL = "https://example.test/releases/download/v1.2.3/linter_linux_x64.tar.gz";

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A fresh folder holding `files` (path → content). */
export function createFolder(files: Record<string, string> = {}): string {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "ci-security-addon-")));

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), content);
  }

  return folder;
}

/** A linter pinned for one platform, whose asset is `ARCHIVE`. */
export function createPin(overrides: Partial<Pin> = {}): Pin {
  return {
    name: "linter",
    version: "1.2.3",
    binary: "linter",
    assets: { [PLATFORM]: { url: ASSET_URL, sha256: sha256(ARCHIVE) } },
    ...overrides,
  };
}

export interface FakeDownload {
  download: Download;
  /** Every URL that was asked for. */
  urls: string[];
}

/** A download that answers with `bytes`, or fails the way a machine with no network does. */
export function createFakeDownload(bytes: Uint8Array | "no network" = ARCHIVE): FakeDownload {
  const urls: string[] = [];

  return {
    urls,
    download: (url) => {
      urls.push(url);

      return bytes === "no network" ? Promise.reject(new Error("getaddrinfo ENOTFOUND example.test")) : Promise.resolve(bytes);
    },
  };
}

export interface FakeExtract {
  extract: Extract;
  /** Every extraction asked for, with the bytes the archive held at that moment. */
  calls: { archive: string; directory: string; member: string; bytes: Buffer }[];
}

/** An extraction that writes a file named after the member, as `tar` would. */
export function createFakeExtract(readArchive: (path: string) => Buffer): FakeExtract {
  const calls: FakeExtract["calls"] = [];

  return {
    calls,
    extract: (archive, directory, member) => {
      calls.push({ archive, directory, member, bytes: readArchive(archive) });
      writeFileSync(join(directory, member), "the linter");
    },
  };
}
