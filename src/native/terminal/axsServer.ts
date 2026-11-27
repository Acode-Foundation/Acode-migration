/**
 * AXS terminal backend lifecycle.
 *
 * Owns single-flight startup of the AXS PTY server: listener health probing,
 * stale-process recovery, port selection and coded startup errors. Every
 * terminal session goes through `ensureReady()` so concurrent tabs share one
 * start attempt instead of racing for the same port.
 */

import sleep from "utils/sleep";

export type AxsHealth = "healthy" | "occupied" | "free";

export type AxsErrorCode =
	| "AXS_NOT_INSTALLED"
	| "AXS_START_FAILED"
	| "AXS_PORT_IN_USE"
	| "AXS_READY_TIMEOUT"
	| "AXS_SESSION_REJECTED"
	| "AXS_UNAVAILABLE";

export interface AxsStartOptions {
	port?: number;
	allowAnyOrigin?: boolean;
}

export interface AxsHost {
	isInstalled(): Promise<boolean> | boolean;
	isAxsRunning(): Promise<boolean> | boolean;
	startAxs(
		installing: boolean,
		logger: (message: string) => void,
		errorLogger: (message: string) => void,
		failsafe: boolean,
		options?: AxsStartOptions,
	): Promise<boolean>;
	stopAxs(): Promise<void> | void;
	getPort?(): Promise<number | null> | number | null;
	lastStartError?: string;
	lastStartOutput?: string;
}

export interface AxsLifecycleDeps {
	getHost: () => AxsHost;
	probe: (port: number, timeoutMs: number) => Promise<AxsHealth>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	logger?: (message: string) => void;
}

export interface EnsureAxsOptions {
	failsafe?: boolean;
	force?: boolean;
	/**
	 * Relax the AXS CORS allowlist. Off by default: the app is served from
	 * `https://localhost`, which is exactly the origin AXS allows.
	 */
	allowAnyOrigin?: boolean;
}

interface StartAttempt {
	ready: boolean;
	details: string;
}

export const DEFAULT_AXS_PORT = 8767;

const PORT_CANDIDATES = 4;
const PROBE_TIMEOUT = 1200;
const COLD_START_TIMEOUT = 45000;
const WARM_START_TIMEOUT = 15000;
const STOP_TIMEOUT = 5000;
const LISTENER_GRACE = 1500;
const POLL_INTERVAL = 200;
const POLL_MAX_INTERVAL = 1000;

const PORT_IN_USE_PATTERN =
	/port is already in use|eaddrinuse|address already in use/i;
const UNKNOWN_ARGUMENT_PATTERN =
	/unexpected argument|unknown argument|unrecognized|wasn't expected|found argument|invalid value/i;
const FATAL_START_PATTERN =
	/failed to spawn|no viable candidates|no such file or directory|permission denied|failed building the runtime|exec format error/i;

export class AxsConnectionError extends Error {
	readonly code: AxsErrorCode;
	readonly details: string;
	readonly retryable: boolean;

	constructor(
		code: AxsErrorCode,
		message: string,
		details = "",
		retryable = true,
	) {
		super(message);
		this.name = "AxsConnectionError";
		this.code = code;
		this.details = details;
		this.retryable = retryable;
	}
}

export class AxsLifecycle {
	port: number | null = null;

	private readonly getHost: () => AxsHost;
	private readonly probe: (
		port: number,
		timeoutMs: number,
	) => Promise<AxsHealth>;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly now: () => number;
	private readonly log: (message: string) => void;
	private inflightStart: Promise<number> | null = null;
	private connectedOnce = false;

	constructor(deps: AxsLifecycleDeps) {
		this.getHost = deps.getHost;
		this.probe = deps.probe;
		this.sleep = deps.sleep ?? sleep;
		this.now = deps.now ?? (() => Date.now());
		this.log = deps.logger ?? (() => {});
	}

	/** Port the server is known to answer on, if it has been resolved. */
	getPort(): number | null {
		return this.port;
	}

	/** True when the listener answers the readiness endpoint right now. */
	async isHealthy(): Promise<boolean> {
		const port = await this.resolvePort();
		if (!port) return false;
		return (await this.probePort(port)) === "healthy";
	}

	/**
	 * Guarantee a live AXS listener and return its port. Concurrent callers
	 * share one start attempt.
	 */
	ensureReady(options: EnsureAxsOptions = {}): Promise<number> {
		if (!this.inflightStart) {
			this.inflightStart = this.start(options).finally(() => {
				this.inflightStart = null;
			});
		}
		return this.inflightStart;
	}

	/** Stop the backend and wait until it stops answering. */
	async stop(port: number | null = this.port): Promise<void> {
		const host = this.getHost();
		try {
			await host.stopAxs();
		} catch (error) {
			this.log(`stopAxs failed: ${messageOf(error)}`);
		}
		await this.waitForListenerExit(port);
	}

	/** Drop cached state. Used by tests. */
	reset(): void {
		this.port = null;
		this.inflightStart = null;
		this.connectedOnce = false;
	}

	private async start(options: EnsureAxsOptions): Promise<number> {
		const host = this.getHost();
		if (!(await host.isInstalled())) {
			throw new AxsConnectionError(
				"AXS_NOT_INSTALLED",
				"Terminal backend is not installed",
				"",
				false,
			);
		}

		if (!options.force) {
			const known = await this.resolvePort();
			if (known) {
				this.port = known;
				if ((await this.probePort(known)) === "healthy") {
					return known;
				}
			}
		}

		// A live PID with a dead listener is the common post-resume state. Give
		// the host a moment to rebound its own socket first (mobile hosts
		// re-listen on foreground) so live sessions are not recycled needlessly.
		if (await host.isAxsRunning()) {
			if (this.port && (await this.waitForHealthy(this.port, LISTENER_GRACE))) {
				return this.port;
			}
			await this.stop(this.port);
		}

		const candidates = candidatePorts(this.port ?? DEFAULT_AXS_PORT);
		let details = "";

		for (let index = 0; index < candidates.length; index += 1) {
			const candidate = candidates[index];
			const health = await this.probePort(candidate);
			if (health === "healthy") {
				this.port = candidate;
				return candidate;
			}
			if (health === "occupied") {
				details = `Port ${candidate} is already in use by another process`;
				continue;
			}

			const timeout =
				this.connectedOnce && index === 0
					? WARM_START_TIMEOUT
					: COLD_START_TIMEOUT;
			const attempt = await this.ensureListener(
				host,
				candidate,
				options.failsafe === true,
				timeout,
				options.allowAnyOrigin === true,
			);
			if (attempt.ready) {
				this.connectedOnce = true;
				this.port = candidate;
				return candidate;
			}

			details = attempt.details || details;
			await this.stop(candidate);
			if (!isPortInUse(details)) break;
		}

		throw this.startError(details);
	}

	private async ensureListener(
		host: AxsHost,
		port: number,
		failsafe: boolean,
		timeout: number,
		allowAnyOrigin: boolean,
	): Promise<StartAttempt> {
		let attempt = await this.attemptStart(
			host,
			port,
			failsafe,
			timeout,
			allowAnyOrigin,
		);

		// Explicitly requested origin relaxation can be rejected by an older AXS
		// build; retry with the restrictive default rather than failing outright.
		if (
			allowAnyOrigin &&
			!attempt.ready &&
			isUnknownArgument(attempt.details)
		) {
			this.log("Retrying AXS start without the origin override");
			await this.waitForListenerExit(port);
			attempt = await this.attemptStart(
				host,
				port,
				failsafe,
				WARM_START_TIMEOUT,
				false,
			);
		}

		return attempt;
	}

	private async attemptStart(
		host: AxsHost,
		port: number,
		failsafe: boolean,
		timeout: number,
		allowAnyOrigin: boolean,
	): Promise<StartAttempt> {
		let hostSettled = false;
		let hostReady = false;
		let hostError = "";

		void Promise.resolve(
			host.startAxs(false, this.log, this.log, failsafe, {
				port,
				allowAnyOrigin,
			}),
		)
			.then((ready) => {
				hostSettled = true;
				hostReady = ready === true;
			})
			.catch((error) => {
				hostSettled = true;
				hostError = messageOf(error);
			});

		const deadline = this.now() + timeout;
		let delay = POLL_INTERVAL;

		while (this.now() < deadline) {
			if ((await this.probePort(port)) === "healthy") {
				return { ready: true, details: "" };
			}
			if (hostSettled && !hostReady && hostError) {
				return { ready: false, details: hostError };
			}
			if (hostSettled && !hostReady) {
				const details = this.hostDetails("");
				if (
					details &&
					(isFatal(details) ||
						isUnknownArgument(details) ||
						isPortInUse(details))
				) {
					return { ready: false, details };
				}
			}
			await this.sleep(delay);
			delay = Math.min(delay * 2, POLL_MAX_INTERVAL);
		}

		return {
			ready: false,
			details:
				this.hostDetails(hostError) ||
				`Timed out waiting for AXS on port ${port}`,
		};
	}

	private hostDetails(fallback: string): string {
		const host = this.getHost();
		return host.lastStartError || host.lastStartOutput || fallback;
	}

	private startError(details: string): AxsConnectionError {
		const suffix = details ? `: ${details}` : "";
		if (isPortInUse(details)) {
			return new AxsConnectionError(
				"AXS_PORT_IN_USE",
				`Terminal backend could not bind a free port${suffix}`,
				details,
			);
		}
		if (/timed out/i.test(details)) {
			return new AxsConnectionError(
				"AXS_READY_TIMEOUT",
				`Terminal backend did not become ready${suffix}`,
				details,
			);
		}
		return new AxsConnectionError(
			"AXS_START_FAILED",
			`Terminal backend failed to start${suffix}`,
			details,
		);
	}

	private async resolvePort(): Promise<number | null> {
		if (this.port) return this.port;
		const host = this.getHost();
		if (typeof host.getPort !== "function") return null;
		try {
			const port = await host.getPort();
			return Number.isFinite(port) && Number(port) > 0
				? Math.floor(Number(port))
				: null;
		} catch {
			return null;
		}
	}

	private async probePort(port: number): Promise<AxsHealth> {
		try {
			return await this.probe(port, PROBE_TIMEOUT);
		} catch {
			return "free";
		}
	}

	private async waitForHealthy(
		port: number,
		timeout: number,
	): Promise<boolean> {
		const deadline = this.now() + timeout;
		while (this.now() < deadline) {
			if ((await this.probePort(port)) === "healthy") return true;
			await this.sleep(POLL_INTERVAL);
		}
		return false;
	}

	private async waitForListenerExit(port: number | null): Promise<void> {
		if (!port) {
			this.port = null;
			return;
		}
		const deadline = this.now() + STOP_TIMEOUT;
		while (this.now() < deadline) {
			if ((await this.probePort(port)) !== "healthy") break;
			await this.sleep(POLL_INTERVAL);
		}
		if (this.port === port) this.port = null;
	}
}

function candidatePorts(preferred: number): number[] {
	const ports = [];
	for (let offset = 0; offset < PORT_CANDIDATES; offset += 1) {
		ports.push(preferred + offset);
	}
	return ports;
}

function isPortInUse(details: string): boolean {
	return PORT_IN_USE_PATTERN.test(details);
}

function isUnknownArgument(details: string): boolean {
	return UNKNOWN_ARGUMENT_PATTERN.test(details);
}

function isFatal(details: string): boolean {
	return FATAL_START_PATTERN.test(details);
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return error == null ? "" : String(error);
}

/** Readiness probe against the AXS `/status` endpoint via the native HTTP bridge. */
function createNativeProbe() {
	return (port: number, timeoutMs: number): Promise<AxsHealth> =>
		new Promise((resolve) => {
			const http = (
				globalThis as {
					Bridge?: {
						http?: {
							sendRequest?: (
								url: string,
								options: Record<string, unknown>,
								success: (response: {
									status?: number;
									data?: unknown;
								}) => void,
								failure: (error: unknown) => void,
							) => void;
						};
					};
				}
			).Bridge?.http;

			if (!http?.sendRequest) {
				resolve("free");
				return;
			}

			let settled = false;
			const finish = (health: AxsHealth) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(health);
			};
			const timer = setTimeout(() => finish("free"), timeoutMs + 250);

			try {
				http.sendRequest(
					`http://127.0.0.1:${port}/status`,
					{ method: "GET", responseType: "text" },
					(response) => {
						const status = Number(response?.status ?? 0);
						const body = String(response?.data ?? "").trim();
						if (status >= 200 && status < 300 && body === "OK") {
							finish("healthy");
						} else if (status > 0) {
							finish("occupied");
						} else {
							finish("free");
						}
					},
					() => finish("free"),
				);
			} catch {
				finish("free");
			}
		});
}

function resolveNativeHost(): AxsHost {
	const host = (globalThis as { Terminal?: AxsHost }).Terminal;
	if (!host) {
		throw new AxsConnectionError(
			"AXS_UNAVAILABLE",
			"Terminal backend bridge is not available",
			"",
			false,
		);
	}
	return host;
}

const axsServer = new AxsLifecycle({
	getHost: resolveNativeHost,
	probe: createNativeProbe(),
	logger: (message) => console.info(`[AXS] ${message}`),
});

export default axsServer;
