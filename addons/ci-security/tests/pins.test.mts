import { describe, expect, it } from "vitest";

import { ACTIONLINT, platformKey, ZIZMOR } from "../files/tools/ci-security/lib/pins.mts";
import type { Pin } from "../files/tools/ci-security/lib/pins.mts";

const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"];

describe.each([
  { pin: ACTIONLINT, repository: "rhysd/actionlint" },
  { pin: ZIZMOR, repository: "zizmorcore/zizmor" },
])("the pin of $pin.name", ({ pin, repository }) => {
  it("names an exact version", () => {
    expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("has a build for macOS and Linux, on both processors", () => {
    expect(Object.keys(pin.assets).sort()).toEqual(PLATFORMS);
  });

  it("takes every build from that version's release on GitHub, over https", () => {
    const prefix = `https://github.com/${repository}/releases/download/v${pin.version}/`;

    expect(urlsOf(pin).filter((url) => !url.startsWith(prefix) || !url.endsWith(".tar.gz"))).toEqual([]);
  });

  it("gives each build a full sha256 of its own", () => {
    const digests = Object.values(pin.assets).map((asset) => asset.sha256);

    expect(digests.filter((digest) => !/^[0-9a-f]{64}$/.test(digest))).toEqual([]);
    expect(new Set(digests).size).toBe(PLATFORMS.length);
  });

  it("names each platform's own build", () => {
    expect(new Set(urlsOf(pin)).size).toBe(PLATFORMS.length);
    expect(pin.assets["darwin-arm64"]?.url).toMatch(/darwin_arm64|aarch64-apple-darwin/);
    expect(pin.assets["darwin-x64"]?.url).toMatch(/darwin_amd64|x86_64-apple-darwin/);
    expect(pin.assets["linux-arm64"]?.url).toMatch(/linux_arm64|aarch64-unknown-linux-gnu/);
    expect(pin.assets["linux-x64"]?.url).toMatch(/linux_amd64|x86_64-unknown-linux-gnu/);
  });

  it("runs the file named after the linter", () => {
    expect(pin.binary).toBe(pin.name);
  });
});

describe("platformKey", () => {
  it("is Node's platform and processor, the way the pins are keyed", () => {
    expect(platformKey("linux", "x64")).toBe("linux-x64");
    expect(platformKey("win32", "arm64")).toBe("win32-arm64");
  });
});

function urlsOf(pin: Pin): string[] {
  return Object.values(pin.assets).map((asset) => asset.url);
}
