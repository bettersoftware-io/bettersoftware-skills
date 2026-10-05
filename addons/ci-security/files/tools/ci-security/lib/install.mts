// Gets a pinned linter onto this machine without running anything unchecked.
//
// The order is the point: download, check the sha256, and only then take the
// binary out. A download with another checksum is thrown away before it
// touches the disk. The archive is kept so the next run needs no network, and
// it is checked again every time: what runs always comes out of bytes whose
// checksum was verified in this run, never out of a binary an earlier run
// left behind.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Pin } from "./pins.mts";

/** Fetches the file at `url`. Rejects when it cannot. Replaced in tests. */
export type Download = (url: string) => Promise<Uint8Array>;

/** Takes the file called `member` out of the archive, into `directory`. Throws when it cannot. Replaced in tests. */
export type Extract = (archive: string, directory: string, member: string) => void;

export interface InstallOptions {
  pin: Pin;
  /** `<process.platform>-<process.arch>`. */
  platform: string;
  /** Where archives are kept between runs. A folder git ignores. */
  cache: string;
  download: Download;
  extract: Extract;
}

/** `reason` is why the linter could not be run. It is never a finding about the project. */
export type Installed = { ok: true; binary: string } | { ok: false; reason: string };

export async function installVerified({ pin, platform, cache, download, extract }: InstallOptions): Promise<Installed> {
  const asset = pin.assets[platform];

  if (asset === undefined) {
    return {
      ok: false,
      reason: `there is no pinned ${pin.name} ${pin.version} build for ${platform} (pinned: ${Object.keys(pin.assets).join(", ")}). Run it on one of those, or in CI.`,
    };
  }

  const archive = archivePath(cache, pin, platform);
  const directory = dirname(archive);
  const binary = join(directory, pin.binary);

  // Gone before anything else, so that no path through this function ends
  // with an unchecked binary where the caller expects a checked one.
  rmSync(binary, { force: true });

  if (!existsSync(archive) || sha256Of(readFileSync(archive)) !== asset.sha256) {
    let bytes: Uint8Array;

    try {
      bytes = await download(asset.url);
    } catch (error) {
      return {
        ok: false,
        reason: `could not download ${asset.url}: ${messageOf(error)}. The first run needs the network; after that the kept archive is used.`,
      };
    }

    const actual = sha256Of(bytes);

    if (actual !== asset.sha256) {
      return {
        ok: false,
        reason: `the download of ${asset.url} was refused: its checksum is wrong (expected sha256 ${asset.sha256}, got ${actual}). It was thrown away and nothing was run. If you are behind a proxy it may have answered with a page of its own; otherwise treat the release as changed and do not move the pin to match.`,
      };
    }

    mkdirSync(directory, { recursive: true });
    writeFileSync(archive, bytes);
  }

  try {
    extract(archive, directory, pin.binary);
  } catch (error) {
    rmSync(binary, { force: true });

    return { ok: false, reason: `could not take ${pin.binary} out of the archive: ${messageOf(error)}` };
  }

  return { ok: true, binary };
}

/** Where a build's archive is kept: one folder per linter, version and platform. */
export function archivePath(cache: string, pin: Pin, platform: string): string {
  const url = pin.assets[platform]?.url ?? "";

  return join(cache, `${pin.name}-${pin.version}-${platform}`, url.slice(url.lastIndexOf("/") + 1));
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
