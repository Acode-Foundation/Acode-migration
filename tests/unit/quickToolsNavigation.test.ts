// @vitest-environment happy-dom

import { defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { afterEach, expect, test, vi } from "vitest";
import {
	createQuickToolKeyEvent,
	runQuickToolKey,
} from "cm/quickToolsNavigation";

vi.hoisted(() => {
	Object.defineProperty(navigator, "platform", {
		configurable: true,
		value: "MacIntel",
	});
	globalThis.Bridge = { platformId: "ios" };
});

vi.mock("utils/keyboardEvent", () => ({
	default: (type: string, init: KeyboardEventInit) =>
		new KeyboardEvent(type, init),
}));

const views: EditorView[] = [];

afterEach(() => {
	views.splice(0).forEach((view) => view.destroy());
	document.body.replaceChildren();
});

test.each([
	false,
	true,
])("iOS Ctrl+Right moves by word with Shift=%s", (shiftKey) => {
	const view = createView();
	expect(runQuickToolKey(view, 39, { ctrlKey: true, shiftKey })).toBe(true);
	expect(view.state.selection.main.head).toBe(3);
	expect(view.state.selection.main.anchor).toBe(shiftKey ? 0 : 3);
	expect(runQuickToolKey(view, 37, { ctrlKey: true, shiftKey })).toBe(true);
	expect(view.state.selection.main.head).toBe(0);
});

test("unbound F1 does not run a letter shortcut on iOS", () => {
	const view = createView();
	expect(createQuickToolKeyEvent(112).key).toBe("F1");
	expect(runQuickToolKey(view, 112, { ctrlKey: true, shiftKey: true })).toBe(
		false,
	);
	expect(view.state.selection.main.head).toBe(0);
});

test("an explicitly bound function key still runs its own command", () => {
	const run = vi.fn(() => true);
	const view = createView([{ key: "Ctrl-Shift-F1", run }]);
	expect(runQuickToolKey(view, 112, { ctrlKey: true, shiftKey: true })).toBe(
		true,
	);
	expect(run).toHaveBeenCalledOnce();
});

function createView(bindings = []) {
	const view = new EditorView({
		state: EditorState.create({
			doc: "one two",
			extensions: [keymap.of([...bindings, ...defaultKeymap])],
		}),
		parent: document.body,
	});
	views.push(view);
	return view;
}
