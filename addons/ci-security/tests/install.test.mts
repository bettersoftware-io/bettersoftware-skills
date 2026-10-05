import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { archivePath, installVerified, sha256Of } from "../files/tools/ci-security/lib/install.mts";
import { ARCHIVE, ASSET_URL, createFakeDownload, createFakeExtract, createFolder, createPin, PLATFORM, sha256, TAMPERED } from "./support.mts";

describe("installing a pinned linter", () => {
  it("downloads the asset pinned for this platform, and hands back the binary taken out of it", async () => {
    const cache = createFolder();
    const { download, urls } = createFakeDownload();
    const { extract, calls } = createFakeExtract(readFileSync);

    const installed = await installVerified({ pin: createPin(), platform: PLATFORM, cache, download, extract });

    expect(urls).toEqual([ASSET_URL]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.member).toBe("linter");
    expect(calls[0]?.bytes.equals(ARCHIVE)).toBe(true);
    expect(installed).toEqual({ ok: true, binary: join(dirname(archivePath(cache, createPin(), PLATFORM)), "linter") });
  });

  it("refuses a download whose checksum is not the pinned one: nothing is kept and nothing is taken out of it", async () => {
    const cache = createFolder();
    const { download } = createFakeDownload(TAMPERED);
    const { extract, calls } = createFakeExtract(readFileSync);

    const installed = await installVerified({ pin: createPin(), platform: PLATFORM, cache, download, extract });

    expect(installed.ok).toBe(false);
    expect(installed.ok ? "" : installed.reason).toContain(`expected sha256 ${sha256(ARCHIVE)}`);
    expect(installed.ok ? "" : installed.reason).toContain(`got ${sha256(TAMPERED)}`);
    expect(calls).toEqual([]);
    expect(listFiles(cache)).toEqual([]);
  });

  it("reports a platform that has no pinned build, without downloading anything", async () => {
    const cache = createFolder();
    const { download, urls } = createFakeDownload();
    const { extract, calls } = createFakeExtract(readFileSync);

    const installed = await installVerified({ pin: createPin(), platform: "win32-x64", cache, download, extract });

    expect(installed).toEqual({
      ok: false,
      reason: "there is no pinned linter 1.2.3 build for win32-x64 (pinned: linux-x64). Run it on one of those, or in CI.",
    });
    expect(urls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("reports that it could not run when the download fails, as it does with no network", async () => {
    const cache = createFolder();
    const { download } = createFakeDownload("no network");
    const { extract, calls } = createFakeExtract(readFileSync);

    const installed = await installVerified({ pin: createPin(), platform: PLATFORM, cache, download, extract });

    expect(installed.ok).toBe(false);
    expect(installed.ok ? "" : installed.reason).toContain(`could not download ${ASSET_URL}: getaddrinfo ENOTFOUND example.test`);
    expect(installed.ok ? "" : installed.reason).toContain("needs the network");
    expect(calls).toEqual([]);
  });

  it("needs no network the second time: the archive it kept is checked again and used", async () => {
    const cache = createFolder();
    const first = createFakeExtract(readFileSync);

    await installVerified({ pin: createPin(), platform: PLATFORM, cache, download: createFakeDownload().download, extract: first.extract });

    const offline = createFakeDownload("no network");
    const second = createFakeExtract(readFileSync);
    const installed = await installVerified({ pin: createPin(), platform: PLATFORM, cache, download: offline.download, extract: second.extract });

    expect(installed.ok).toBe(true);
    expect(offline.urls).toEqual([]);
    expect(second.calls[0]?.bytes.equals(ARCHIVE)).toBe(true);
  });

  it("does not trust a kept archive whose checksum is wrong: it downloads again, and what it runs is the download", async () => {
    const cache = createFolder();
    const kept = archivePath(cache, createPin(), PLATFORM);

    mkdirSync(dirname(kept), { recursive: true });
    writeFileSync(kept, TAMPERED);

    const { download, urls } = createFakeDownload();
    const { extract, calls } = createFakeExtract(readFileSync);
    const installed = await installVerified({ pin: createPin(), platform: PLATFORM, cache, download, extract });

    expect(installed.ok).toBe(true);
    expect(urls).toEqual([ASSET_URL]);
    expect(calls[0]?.bytes.equals(ARCHIVE)).toBe(true);
  });

  it("takes nothing out of a kept archive whose checksum is wrong when it cannot download a good one", async () => {
    const cache = createFolder();
    const kept = archivePath(cache, createPin(), PLATFORM);

    mkdirSync(dirname(kept), { recursive: true });
    writeFileSync(kept, TAMPERED);

    const { extract, calls } = createFakeExtract(readFileSync);
    const installed = await installVerified({ pin: createPin(), platform: PLATFORM, cache, download: createFakeDownload("no network").download, extract });

    expect(installed.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("leaves no binary from an earlier run to be run when it could not get a checked archive", async () => {
    const cache = createFolder();
    const stale = join(dirname(archivePath(cache, createPin(), PLATFORM)), "linter");

    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "a binary nobody checked");

    const { extract } = createFakeExtract(readFileSync);
    const installed = await installVerified({ pin: createPin(), platform: PLATFORM, cache, download: createFakeDownload("no network").download, extract });

    expect(installed.ok).toBe(false);
    expect(existsSync(stale)).toBe(false);
  });

  it("leaves nothing to run when taking the binary out of the archive fails half way", async () => {
    const cache = createFolder();
    const installed = await installVerified({
      pin: createPin(),
      platform: PLATFORM,
      cache,
      download: createFakeDownload().download,
      extract: (_archive, directory, member) => {
        writeFileSync(join(directory, member), "half a binary");

        throw new Error("tar: unexpected end of file");
      },
    });

    expect(installed).toEqual({ ok: false, reason: "could not take linter out of the archive: tar: unexpected end of file" });
    expect(existsSync(join(dirname(archivePath(cache, createPin(), PLATFORM)), "linter"))).toBe(false);
  });

  it("keeps each version and platform apart, so a new pin never runs an old download", () => {
    const cache = "/cache";

    expect(archivePath(cache, createPin(), PLATFORM)).toBe("/cache/linter-1.2.3-linux-x64/linter_linux_x64.tar.gz");
    expect(archivePath(cache, createPin({ version: "1.2.4" }), PLATFORM)).not.toBe(archivePath(cache, createPin(), PLATFORM));
  });
});

describe("sha256Of", () => {
  it("is the sha256 of the bytes, in hex", () => {
    expect(sha256Of(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

/** Every file under `directory`, as paths from it. */
function listFiles(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1));
}
