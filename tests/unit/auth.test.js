import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../../src/lib/config", () => ({ default: { BASE_URL: "https://dev.acode.app", API_BASE: "https://dev.acode.app/api" } }));
vi.mock("../../src/lib/platform", () => ({ default: { isIOS: true } }));

let auth;
let loginEvents;
let exec;
let request;

beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers();
	vi.stubGlobal("document", new EventTarget());
	vi.stubGlobal("window", { BuildInfo: { versionCode: 1016 } });
	vi.stubGlobal("localStorage", {
		getItem(key) { return this[key] ?? null; },
		setItem(key, value) { this[key] = value; },
		removeItem(key) { delete this[key]; },
	});
	exec = vi.fn();
	request = vi.fn();
	vi.stubGlobal("Bridge", { exec });
	vi.stubGlobal("fetch", request);
	({ default: auth, loginEvents } = await import("../../src/lib/auth"));
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

test("coalesces login and verifies a fresh native session before notifying listeners", async () => {
	const completed = vi.fn();
	loginEvents.addListener(completed);
	request.mockResolvedValue(new Response(JSON.stringify({ id: 7, name: "Reviewer" })));
	const first = auth.login();
	const second = auth.login();
	expect(exec).toHaveBeenCalledTimes(1);
	exec.mock.calls[0][0]();
	await Promise.all([first, second]);
	expect(completed).toHaveBeenCalledOnce();
	expect(request).toHaveBeenCalledWith("https://dev.acode.app/api/login", { credentials: "include", cache: "no-store" });
	expect((await auth.getLoggedInUser()).id).toBe(7);
});

test("a rejected session clears cached account state and never reports login success", async () => {
	request.mockResolvedValueOnce(new Response(JSON.stringify({ id: 7 })));
	await auth.getLoggedInUser();
	const completed = vi.fn();
	loginEvents.addListener(completed);
	request.mockImplementation(async () => new Response("{}", { status: 401 }));
	const pending = auth.login();
	const rejected = expect(pending).rejects.toThrow("Sign-in did not complete");
	exec.mock.calls[0][0]();
	await rejected;
	expect(completed).not.toHaveBeenCalled();
	expect(await auth.getLoggedInUser()).toBeNull();
	expect(localStorage["cached-logged-in-user"]).toBeUndefined();
});

test("preserves actionable native errors for every waiter and permits a new attempt", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	const message = "Too many sign-in attempts. Please wait 2 minutes and try again.";
	const first = expect(auth.login()).rejects.toThrow(message);
	const second = expect(auth.login()).rejects.toThrow(message);
	exec.mock.calls[0][1](message);
	await Promise.all([first, second]);
	const retry = expect(auth.login()).rejects.toThrow("Sign-in cancelled");
	expect(exec).toHaveBeenCalledTimes(2);
	exec.mock.calls[1][1]("Sign-in cancelled");
	await retry;

	const timedOut = expect(auth.login()).rejects.toThrow("Sign-in timed out");
	document.dispatchEvent(new Event("resume"));
	await vi.advanceTimersByTimeAsync(60_000);
	await timedOut;
	const nextAttempt = expect(auth.login()).rejects.toThrow("Current attempt failed");
	exec.mock.calls[2][1]("Previous attempt cancelled");
	await Promise.resolve();
	exec.mock.calls[3][1]("Current attempt failed");
	await nextAttempt;
});

test("verification cannot fall back to an offline cached account", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	localStorage.setItem("cached-logged-in-user", JSON.stringify({ id: 7 }));
	request.mockRejectedValue(new Error("Connection failed"));
	await expect(auth.getLoggedInUser()).resolves.toEqual({ id: 7 });
	const pending = expect(auth.login()).rejects.toThrow("Connection failed");
	exec.mock.calls[0][0]();
	await pending;
});

test("account settings use the authentication browser and refresh after it closes", async () => {
	request.mockResolvedValue(new Response("{}", { status: 401 }));
	const pending = auth.openAccount();
	const [closed, , service, action, args] = exec.mock.calls[0];
	expect([service, action, args]).toEqual(["Authenticator", "openAccount", [{ baseUrl: "https://dev.acode.app" }]]);
	expect(request).not.toHaveBeenCalled();
	closed();
	await expect(pending).resolves.toBeNull();
	expect(request).toHaveBeenCalledTimes(1);
});

test("closing account settings offline skips refresh without reporting a signed-out session", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	request.mockResolvedValueOnce(new Response(JSON.stringify({ id: 7 })));
	await auth.getLoggedInUser();
	await vi.advanceTimersByTimeAsync(600_000);
	request.mockRejectedValue(new Error("Offline"));
	const pending = auth.openAccount();
	exec.mock.calls[0][0]();
	await expect(pending).resolves.toBeUndefined();
});
