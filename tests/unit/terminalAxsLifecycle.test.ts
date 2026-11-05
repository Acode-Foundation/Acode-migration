import { describe, expect, it } from "vitest";
import {
	AxsLifecycle,
	DEFAULT_AXS_PORT,
	type AxsHealth,
	type AxsHost,
	type AxsStartOptions,
} from "../../src/native/terminal/axsServer";

interface FakeHost extends AxsHost {
	installed: boolean;
	pidAlive: boolean;
	running: number | null;
	stopCalls: number;
	startCalls: Array<AxsStartOptions | undefined>;
	behavior: (
		options: AxsStartOptions | undefined,
		host: FakeHost,
	) => Promise<boolean> | boolean;
}

function createHarness() {
	const health = new Map<number, AxsHealth>();
	let time = 0;

	const host: FakeHost = {
		installed: true,
		pidAlive: false,
		running: null,
		stopCalls: 0,
		startCalls: [],
		lastStartError: "",
		lastStartOutput: "",
		behavior: null as never,
		async isInstalled() {
			return host.installed;
		},
		async isAxsRunning() {
			return host.pidAlive;
		},
		async stopAxs() {
			host.stopCalls += 1;
			host.pidAlive = false;
			host.running = null;
		},
		async startAxs(
			_installing: boolean,
			_logger: (message: string) => void,
			_errorLogger: (message: string) => void,
			_failsafe: boolean,
			options?: AxsStartOptions,
		) {
			host.startCalls.push(options);
			if (host.behavior) return host.behavior(options, host);
			health.set(options?.port ?? DEFAULT_AXS_PORT, "healthy");
			return true;
		},
		getPort() {
			return host.running;
		},
	};

	const lifecycle = new AxsLifecycle({
		getHost: () => host,
		probe: async (port: number) => health.get(port) ?? "free",
		sleep: async (ms: number) => {
			time += ms;
		},
		now: () => time,
		logger: () => {},
	});

	return { host, health, lifecycle };
}

describe("AXS lifecycle", () => {
	it("reuses a healthy listener without starting a process", async () => {
		const { host, health, lifecycle } = createHarness();
		host.running = DEFAULT_AXS_PORT;
		health.set(DEFAULT_AXS_PORT, "healthy");

		await expect(lifecycle.ensureReady()).resolves.toBe(DEFAULT_AXS_PORT);

		expect(host.startCalls).toHaveLength(0);
		expect(lifecycle.getPort()).toBe(DEFAULT_AXS_PORT);
	});

	it("recycles a live pid whose listener is gone", async () => {
		const { host, health, lifecycle } = createHarness();
		host.pidAlive = true;
		host.running = DEFAULT_AXS_PORT;
		health.set(DEFAULT_AXS_PORT, "free");

		await expect(lifecycle.ensureReady()).resolves.toBe(DEFAULT_AXS_PORT);

		expect(host.stopCalls).toBe(1);
		expect(host.startCalls).toHaveLength(1);
		expect(host.startCalls[0]?.port).toBe(DEFAULT_AXS_PORT);
	});

	it("lets the host re-bind its own listener before recycling", async () => {
		let time = 0;
		let probes = 0;
		const host = {
			installed: true,
			pidAlive: true,
			running: DEFAULT_AXS_PORT,
			lastStartError: "",
			lastStartOutput: "",
			stopCalls: 0,
			startCalls: [] as number[],
			async isInstalled() {
				return true;
			},
			async isAxsRunning() {
				return true;
			},
			async stopAxs() {
				host.stopCalls += 1;
			},
			async startAxs(
				_installing: boolean,
				_logger: (message: string) => void,
				_errorLogger: (message: string) => void,
				_failsafe: boolean,
				options?: AxsStartOptions,
			) {
				host.startCalls.push(options?.port ?? 0);
				return true;
			},
			getPort() {
				return DEFAULT_AXS_PORT;
			},
		};
		const lifecycle = new AxsLifecycle({
			getHost: () => host,
			probe: async () => (++probes > 2 ? "healthy" : "free"),
			sleep: async (ms: number) => {
				time += ms;
			},
			now: () => time,
			logger: () => {},
		});

		await expect(lifecycle.ensureReady()).resolves.toBe(DEFAULT_AXS_PORT);

		expect(host.stopCalls).toBe(0);
		expect(host.startCalls).toHaveLength(0);
	});

	it("skips a port owned by another process", async () => {
		const { host, health, lifecycle } = createHarness();
		health.set(DEFAULT_AXS_PORT, "occupied");

		await expect(lifecycle.ensureReady()).resolves.toBe(DEFAULT_AXS_PORT + 1);

		expect(host.startCalls).toHaveLength(1);
		expect(host.startCalls[0]?.port).toBe(DEFAULT_AXS_PORT + 1);
	});

	it("moves to the next port when a start reports a conflict", async () => {
		const { host, health, lifecycle } = createHarness();
		host.behavior = async (options, target) => {
			const port = options?.port ?? DEFAULT_AXS_PORT;
			if (port === DEFAULT_AXS_PORT) {
				target.lastStartError =
					"Port is already in use please kill all other instances of axs server";
				return false;
			}
			health.set(port, "healthy");
			return true;
		};

		await expect(lifecycle.ensureReady()).resolves.toBe(DEFAULT_AXS_PORT + 1);

		expect(host.startCalls).toHaveLength(2);
	});

	it("shares one start attempt between concurrent callers", async () => {
		const { host, health, lifecycle } = createHarness();
		host.behavior = async (options) => {
			health.set(options?.port ?? DEFAULT_AXS_PORT, "healthy");
			return true;
		};

		const ports = await Promise.all([
			lifecycle.ensureReady(),
			lifecycle.ensureReady(),
			lifecycle.ensureReady(),
		]);

		expect(ports).toEqual([
			DEFAULT_AXS_PORT,
			DEFAULT_AXS_PORT,
			DEFAULT_AXS_PORT,
		]);
		expect(host.startCalls).toHaveLength(1);
	});

	it("reports a coded failure when the backend cannot spawn", async () => {
		const { host, lifecycle } = createHarness();
		host.behavior = async () => {
			throw new Error("Failed to spawn bash: No viable candidates found in PATH");
		};

		await expect(lifecycle.ensureReady()).rejects.toMatchObject({
			name: "AxsConnectionError",
			code: "AXS_START_FAILED",
		});
	});

	it("refuses to start when the backend is not installed", async () => {
		const { host, lifecycle } = createHarness();
		host.installed = false;

		await expect(lifecycle.ensureReady()).rejects.toMatchObject({
			code: "AXS_NOT_INSTALLED",
			retryable: false,
		});
	});

	it("keeps the backend origin allowlist unless it is explicitly relaxed", async () => {
		const { host, lifecycle } = createHarness();

		await expect(lifecycle.ensureReady()).resolves.toBe(DEFAULT_AXS_PORT);

		expect(host.startCalls).toHaveLength(1);
		expect(host.startCalls[0]?.allowAnyOrigin).toBe(false);
	});

	it("retries without the origin override when the backend rejects it", async () => {
		const { host, health, lifecycle } = createHarness();
		host.behavior = async (options, target) => {
			const port = options?.port ?? DEFAULT_AXS_PORT;
			if (options?.allowAnyOrigin) {
				target.lastStartError =
					"error: unexpected argument '--allow-any-origin' found";
				return false;
			}
			health.set(port, "healthy");
			return true;
		};

		await expect(
			lifecycle.ensureReady({ allowAnyOrigin: true }),
		).resolves.toBe(DEFAULT_AXS_PORT);

		expect(host.startCalls).toHaveLength(2);
		expect(host.startCalls[0]?.allowAnyOrigin).toBe(true);
		expect(host.startCalls[1]?.allowAnyOrigin).toBe(false);
	});

	it("times out with a coded error when the listener never answers", async () => {
		const { host, lifecycle } = createHarness();
		host.behavior = () => new Promise<boolean>(() => {});

		await expect(lifecycle.ensureReady()).rejects.toMatchObject({
			code: "AXS_READY_TIMEOUT",
		});
	});

	it("reports unhealthy when no port is known", async () => {
		const { lifecycle } = createHarness();

		await expect(lifecycle.isHealthy()).resolves.toBe(false);
	});

	it("stops the backend and clears the cached port", async () => {
		const { host, health, lifecycle } = createHarness();
		host.running = DEFAULT_AXS_PORT;
		health.set(DEFAULT_AXS_PORT, "healthy");
		await lifecycle.ensureReady();

		await lifecycle.stop();

		expect(host.stopCalls).toBe(1);
		expect(lifecycle.getPort()).toBeNull();
	});
});
