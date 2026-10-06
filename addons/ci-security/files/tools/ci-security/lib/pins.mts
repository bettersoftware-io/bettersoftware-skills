// The two workflow linters, pinned.
//
// Each build is one release asset, named by its exact URL and the sha256 of
// that file. The tool downloads nothing else and runs nothing whose sha256 is
// not the one written here.
//
// To move to a newer release, change `version`, the four URLs and the four
// digests together. The digests are the release assets' own `digest` field:
//
//   gh api repos/rhysd/actionlint/releases/tags/v<VERSION> --jq '.assets[] | "\(.name) \(.digest)"'
//   gh api repos/zizmorcore/zizmor/releases/tags/v<VERSION> --jq '.assets[] | "\(.name) \(.digest)"'
//
// No update bot manages these pins. Leave a release a week before you take
// it, as the bot's config does for everything else.

export interface Asset {
  url: string;
  /** Of the file at `url`, in hex. */
  sha256: string;
}

export interface Pin {
  name: string;
  version: string;
  /** The file to take out of the archive, and to run. */
  binary: string;
  /** `<process.platform>-<process.arch>` → the release asset built for it. */
  assets: Record<string, Asset>;
}

const ACTIONLINT_VERSION = "1.7.12";
const ACTIONLINT_RELEASE = `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}`;

/** Is each workflow valid? Syntax, expressions, runner labels, action inputs. */
export const ACTIONLINT: Pin = {
  name: "actionlint",
  version: ACTIONLINT_VERSION,
  binary: "actionlint",
  assets: {
    "darwin-arm64": {
      url: `${ACTIONLINT_RELEASE}/actionlint_${ACTIONLINT_VERSION}_darwin_arm64.tar.gz`,
      sha256: "aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f",
    },
    "darwin-x64": {
      url: `${ACTIONLINT_RELEASE}/actionlint_${ACTIONLINT_VERSION}_darwin_amd64.tar.gz`,
      sha256: "5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644",
    },
    "linux-arm64": {
      url: `${ACTIONLINT_RELEASE}/actionlint_${ACTIONLINT_VERSION}_linux_arm64.tar.gz`,
      sha256: "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6",
    },
    "linux-x64": {
      url: `${ACTIONLINT_RELEASE}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz`,
      sha256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8",
    },
  },
};

const ZIZMOR_VERSION = "1.30.1";
const ZIZMOR_RELEASE = `https://github.com/zizmorcore/zizmor/releases/download/v${ZIZMOR_VERSION}`;

/** Is each workflow safe? Injection, kept credentials, wide permissions, unpinned actions. */
export const ZIZMOR: Pin = {
  name: "zizmor",
  version: ZIZMOR_VERSION,
  binary: "zizmor",
  assets: {
    "darwin-arm64": {
      url: `${ZIZMOR_RELEASE}/zizmor-aarch64-apple-darwin.tar.gz`,
      sha256: "e28d22b087f9ebb8d99da6e740d348c930f559961c7c3f12badda54f882195a2",
    },
    "darwin-x64": {
      url: `${ZIZMOR_RELEASE}/zizmor-x86_64-apple-darwin.tar.gz`,
      sha256: "10e6b18b11ea07e515a16f0f0518c7b07527bc9977c1fd5698181ce7f3554202",
    },
    "linux-arm64": {
      url: `${ZIZMOR_RELEASE}/zizmor-aarch64-unknown-linux-gnu.tar.gz`,
      sha256: "7ff1dce33bdd18fd2a4affe63bdd47efcccca97b2cec1c1863ec26e9e2647540",
    },
    "linux-x64": {
      url: `${ZIZMOR_RELEASE}/zizmor-x86_64-unknown-linux-gnu.tar.gz`,
      sha256: "e65324f4430c2717591937edcec90ccbefaf14c174f8ec9415e03ca875b46e1a",
    },
  },
};

/** The key a build is pinned under, from Node's own names for the machine. */
export function platformKey(platform: string, arch: string): string {
  return `${platform}-${arch}`;
}
