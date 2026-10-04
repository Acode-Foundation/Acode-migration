import fs from "node:fs";
import vm from "node:vm";
import { Window } from "happy-dom";
import { expect, test, vi } from "vitest";

const html = fs.readFileSync(
	new URL("../../src/index.html", import.meta.url),
	"utf8",
);

test.each([
	false,
	true,
])("shows the splash Beta badge only on iOS: %s", (ios) => {
	const window = new Window();
	window.document.head.innerHTML = html.match(/<style>([\s\S]*?)<\/style>/)[0];
	window.document.body.innerHTML = html.match(
		/<div id="splash">[\s\S]*?<\/div>\s*<\/div>/,
	)[0];
	if (ios)
		window.webkit = { messageHandlers: { exec: { postMessage: vi.fn() } } };
	const scriptWindow = new Window();
	scriptWindow.document.documentElement.innerHTML = html;
	const scriptSource =
		scriptWindow.document.querySelector("script")?.textContent ?? "";
	scriptWindow.happyDOM.abort();
	vm.runInNewContext(scriptSource, {
		window,
		document: window.document,
		localStorage: window.localStorage,
		navigator: window.navigator,
		getComputedStyle: window.getComputedStyle.bind(window),
	});
	const badge = window.document.querySelector(".splash-beta");
	expect(badge.textContent).toBe("Beta");
	expect(window.getComputedStyle(badge).display).toBe(
		ios ? "inline-block" : "none",
	);
	window.happyDOM.abort();
});
