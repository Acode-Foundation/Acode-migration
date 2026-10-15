import fs from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { expect, test, vi } from "vitest";

const source = fs.readFileSync(
	new URL("../../src/boot.js", import.meta.url),
	"utf8",
);
const require = createRequire(import.meta.url);
const devOrigin = "https://192.168.1.2:4000";

test.each([
	["connected", true, true, devOrigin],
	["offline", true, new Error("offline"), "."],
	["unavailable bundle", true, false, "."],
	["packaged build", false, true, "."],
])("%s preserves the API origin while selecting web assets", async (name, dev, response, assetOrigin) => {
	const loaded = [];
	const location = {
		origin: "https://localhost",
		replace: vi.fn(),
		reload: vi.fn(),
	};
	const timeout = vi.fn(() => 1);
	const clearTimeout = vi.fn();
	const fetch = vi.fn(async () => {
		if (response instanceof Error) throw response;
		return { ok: response };
	});
	const sockets = [];
	await vm.runInNewContext(source, {
		__DEV_MODE__: dev,
		__DEV_HOST__: "192.168.1.2",
		__DEV_PORT__: "4000",
		__DEV_PROTO__: "https",
		location,
		window: { location, nativeReady: Promise.resolve() },
		fetch,
		AbortController,
		console: { error: vi.fn() },
		setTimeout: timeout,
		clearTimeout,
		document: {
			createElement: () => ({}),
			head: {
				appendChild(element) {
					loaded.push(element.src || element.href);
					if (element.onload) queueMicrotask(element.onload);
				},
			},
		},
		WebSocket: class {
			constructor(url) {
				sockets.push(url);
			}
		},
	});
	await new Promise((resolve) => setImmediate(resolve));
	expect(location.replace).not.toHaveBeenCalled();
	expect(location.origin).toBe("https://localhost");
	expect(loaded).toEqual(
		["native.js", "main.css", "main.js"].map(
			(file) => `${assetOrigin}/build/${file}`,
		),
	);
	expect(sockets).toHaveLength(assetOrigin === devOrigin ? 1 : 0);
	if (dev) {
		expect(timeout).toHaveBeenCalledWith(expect.any(Function), 3000);
		expect(clearTimeout).toHaveBeenCalledWith(1);
		expect(fetch).toHaveBeenCalledWith(`${devOrigin}/build/main.js`, {
			method: "HEAD",
			cache: "no-store",
			signal: expect.any(AbortSignal),
		});
	} else expect(fetch).not.toHaveBeenCalled();
});

test("lazy assets resolve from the loaded bundle instead of a baked-in dev origin", () => {
	const [config] = require("../../rspack.config.js")(
		{},
		{ mode: "development" },
	);
	expect(config.output.publicPath).toBe("auto");
});
