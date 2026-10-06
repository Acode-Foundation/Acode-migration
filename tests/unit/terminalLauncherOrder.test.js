import { describe, expect, it } from "vitest";
import { readLauncher } from "../helpers/initLauncher";

/**
 * Bash registers a function where its definition is executed, so a top-level
 * call above the definition fails at runtime with "<name>: not found" — the
 * install path used to call refresh_generated_artifacts before defining it.
 * The extracted-function tests cannot see that, because they rebuild a script
 * with the definition already in place, so the launcher's own order is checked
 * here instead.
 */

const definitionName = (line) =>
	line.match(/^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{$/)?.[1] ?? null;

const heredocDelimiter = (line) =>
	line.match(/<<-?'?([A-Za-z_][A-Za-z0-9_]*)'?/)?.[1] ?? null;

const callName = (line) =>
	line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s|$)/)?.[1] ?? null;

const callsBeforeDefinitions = (source) => {
	const definitions = new Map();
	const calls = new Map();
	const outOfOrder = [];
	let heredoc = null;
	let inBody = false;

	source.split("\n").forEach((line, index) => {
		const number = index + 1;

		if (heredoc) {
			if (line.trim() === heredoc) heredoc = null;
			return;
		}

		const heredocStart = heredocDelimiter(line);
		const definition = definitionName(line);

		if (!inBody && definition) {
			definitions.set(definition, number);
			inBody = true;
		} else if (inBody) {
			if (line === "}") inBody = false;
		} else {
			const call = callName(line);

			if (call) calls.set(call, calls.get(call) ?? number);
		}

		if (heredocStart) heredoc = heredocStart;
	});

	for (const [name, line] of calls) {
		if (definitions.has(name) && definitions.get(name) > line) {
			outOfOrder.push(
				`${name} (called at ${line}, defined at ${definitions.get(name)})`,
			);
		}
	}

	return outOfOrder;
};

describe("launcher function ordering", () => {
	it("defines every function before the top-level code that calls it", () => {
		expect(callsBeforeDefinitions(readLauncher())).toEqual([]);
	});
});
