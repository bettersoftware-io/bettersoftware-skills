import { type E2eConfig, OUT_DIR, SERVER_URL } from "./e2e/lib/config.mts";

// What `pnpm e2e` builds, starts and runs. This file is the project's: add a
// mode, or change a command, here. The runner is in tools/e2e and belongs to
// the add-on.
//
// A command is the program and its arguments, never `pnpm …`: a package
// manager's wrapper can die on the stop signal while the server it started
// lives on. Every address is printed by the program that owns it and read
// from its `ready` line, so no port is written down here.
const config: E2eConfig = {
  // The package that holds the specs. The specs of a mode are in src/<mode>/.
  tests: "packages/e2e",

  client: {
    cwd: "packages/client-react",
    // A production build, not the dev server: it is what ships, and a page
    // loads as a few files instead of one request for each module.
    build: ["node_modules/.bin/vite", "build", "--outDir", OUT_DIR, "--emptyOutDir"],
    // Vite takes the next free port when its own is taken, and prints the one it got.
    serve: ["node_modules/.bin/vite", "preview", "--outDir", OUT_DIR, "--host", "127.0.0.1"],
    ready: /Local:\s+(http:\/\/[^\s/]+)/,
  },

  modes: {
    // The client alone, on its in-browser simulator. The variable is set to
    // nothing so that one left in the shell cannot turn this into the other mode.
    sim: {
      env: { VITE_SERVER_URL: "" },
    },

    // The client against the real server, started the way it is in production.
    fullstack: {
      server: {
        cwd: "packages/server",
        command: ["node", "src/index.ts"],
        // 0 asks the system for a free port; the server prints the one it got.
        env: { PORT: "0" },
        ready: /listening on (ws:\/\/\S+)/,
      },
      env: { VITE_SERVER_URL: SERVER_URL },
    },
  },
};

export default config;
