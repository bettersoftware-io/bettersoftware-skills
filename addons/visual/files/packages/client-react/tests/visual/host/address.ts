/** Where the visual host is served. The host's Vite config and the Playwright config both read it. */
export const HOST = "127.0.0.1";
export const PORT = 4319;
export const HOST_URL = `http://${HOST}:${PORT}`;

/** The element the picture is taken of. It carries `data-visual-ready="true"` once the scenario is seeded. */
export const FRAME_TESTID = "visual-frame";
