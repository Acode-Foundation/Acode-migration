// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import installFullscreen from "../../src/platforms/ios/fullscreen";

const native = vi.fn<(active: boolean) => Promise<void>>().mockResolvedValue(undefined);
const descriptors = [
	[document, "fullscreenElement"], [ShadowRoot.prototype, "fullscreenElement"],
	[document, "fullscreenEnabled"], [Element.prototype, "requestFullscreen"],
	[document, "exitFullscreen"], [HTMLElement.prototype, "showPopover"],
	[HTMLElement.prototype, "hidePopover"],
] as const;
const saved = descriptors.map(([target, key]) => Object.getOwnPropertyDescriptor(target, key));
beforeAll(() => {
	HTMLElement.prototype.showPopover = function () {};
	HTMLElement.prototype.hidePopover = function () {};
	installFullscreen(native);
});
afterEach(async () => {
	await document.exitFullscreen();
	document.body.replaceChildren();
	native.mockClear();
});
afterAll(() => {
	descriptors.forEach(([target, key], index) => {
		const descriptor = saved[index];
		if (descriptor) Object.defineProperty(target, key, descriptor);
		else Reflect.deleteProperty(target, key);
	});
});

test("enters and exits without moving the target or losing plugin style changes", async () => {
	const target = document.createElement("div");
	target.style.cssText = "top:12px;overflow:hidden";
	target.setAttribute("popover", "auto");
	document.body.append(target);
	const changed = vi.fn();
	document.addEventListener("fullscreenchange", changed);
	await target.requestFullscreen();
	expect(document.fullscreenElement).toBe(target);
	expect(target.parentElement).toBe(document.body);
	expect(target.hasAttribute("data-acode-fullscreen")).toBe(true);
	target.style.color = "red";
	await document.exitFullscreen();
	expect(document.fullscreenElement).toBeNull();
	expect(target.getAttribute("popover")).toBe("auto");
	expect(target.hasAttribute("data-acode-fullscreen")).toBe(false);
	expect(target.style.top).toBe("12px");
	expect(target.style.color).toBe("red");
	expect(changed).toHaveBeenCalledTimes(2);
	expect(native.mock.calls).toEqual([[true], [false]]);
	document.removeEventListener("fullscreenchange", changed);
});

test("serializes a pending entry and exit and protects a foreign owner", async () => {
	const target = document.createElement("div");
	const other = document.createElement("div");
	document.body.append(target, other);
	const entering = target.requestFullscreen();
	const exiting = document.exitFullscreen();
	await Promise.all([entering, exiting]);
	expect(document.fullscreenElement).toBeNull();
	await target.requestFullscreen();
	await expect(other.requestFullscreen()).rejects.toThrow(/already active/);
	expect(document.fullscreenElement).toBe(target);
	await target.requestFullscreen();
	expect(native.mock.calls).toEqual([[true], [false], [true]]);
});

test("retargets nested shadow owners and exits when an outer shadow ancestor is removed", async () => {
	const host = document.createElement("div");
	document.body.append(host);
	const outer = host.attachShadow({ mode: "open" });
	const inner = document.createElement("div");
	outer.append(inner);
	const shadow = inner.attachShadow({ mode: "open" });
	const target = document.createElement("div");
	shadow.append(target);
	await target.requestFullscreen();
	expect(document.fullscreenElement).toBe(host);
	expect(outer.fullscreenElement).toBe(inner);
	expect(shadow.fullscreenElement).toBe(target);
	inner.remove();
	await vi.waitFor(() => expect(target.hasAttribute("data-acode-fullscreen")).toBe(false));
	expect(document.fullscreenElement).toBeNull();
	expect(native).toHaveBeenLastCalledWith(false);
});

test("rolls back a failed native entry and rejects disconnected elements", async () => {
	const target = document.createElement("div");
	await expect(target.requestFullscreen()).rejects.toThrow(/connected/);
	expect(native).not.toHaveBeenCalled();
	document.body.append(target);
	native.mockRejectedValueOnce(new Error("App is backgrounded"));
	await expect(target.requestFullscreen()).rejects.toThrow(/backgrounded/);
	expect(document.fullscreenElement).toBeNull();
	expect(target.hasAttribute("popover")).toBe(false);
	expect(target.hasAttribute("data-acode-fullscreen")).toBe(false);
	await target.requestFullscreen();
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
	await vi.waitFor(() => expect(document.fullscreenElement).toBeNull());
});

test.each(["menu", "body", "game"])("Back closes a shadow menu when focus is on %s", async (focus) => {
	const owner = document.createElement("div");
	document.body.append(owner);
	const shadow = owner.attachShadow({ mode: "open" });
	const menu = document.createElement("div");
	menu.setAttribute("role", "dialog");
	menu.setAttribute("aria-modal", "true");
	const resume = document.createElement("button");
	const game = document.createElement("button");
	menu.append(resume);
	shadow.append(menu, game);
	await owner.requestFullscreen();
	resume.focus();
	if (focus === "body") resume.blur();
	if (focus === "game") game.focus();
	const back = vi.fn();
	document.addEventListener("fullscreenbackbutton", back);
	menu.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		menu.hidden = true;
		event.preventDefault();
	});
	document.dispatchEvent(new Event("fullscreenbackbutton"));
	expect(menu.hidden).toBe(true);
	expect(back).not.toHaveBeenCalled();
	expect(document.fullscreenElement).toBe(owner);
	document.removeEventListener("fullscreenbackbutton", back);
});

test("Back retains callback delivery when a menu does not handle Escape or belongs to another owner", async () => {
	const owner = document.createElement("div");
	const menu = document.createElement("div");
	menu.setAttribute("role", "dialog");
	menu.setAttribute("aria-modal", "true");
	const button = document.createElement("button");
	menu.append(button);
	owner.append(menu);
	document.body.append(owner);
	await owner.requestFullscreen();
	button.focus();
	const back = vi.fn();
	document.addEventListener("fullscreenbackbutton", back);
	document.dispatchEvent(new Event("fullscreenbackbutton"));
	expect(back).toHaveBeenCalledOnce();
	expect(document.fullscreenElement).toBe(owner);
	const escape = vi.fn((event: Event) => event.preventDefault());
	menu.addEventListener("keydown", escape);
	menu.hidden = true;
	document.dispatchEvent(new Event("fullscreenbackbutton"));
	expect(back).toHaveBeenCalledTimes(2);
	expect(escape).not.toHaveBeenCalled();
	menu.hidden = false;
	document.body.append(menu);
	button.focus();
	document.dispatchEvent(new Event("fullscreenbackbutton"));
	expect(back).toHaveBeenCalledTimes(3);
	expect(escape).not.toHaveBeenCalled();
	document.removeEventListener("fullscreenbackbutton", back);
});
