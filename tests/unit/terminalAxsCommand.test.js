import { describe, expect, it } from "vitest";
import { readAsset } from "../helpers/initLauncher";

/**
 * AXS (`acodex_server`) does not run its `-c` payload through a shell.
 * `create_terminal` tokenizes it with `split_whitespace()` and treats the first
 * token as the program to spawn:
 *
 *   let mut program = String::from("login");
 *   let parts: Vec<String> = cmd.split_whitespace().map(|s| s.to_string()).collect();
 *   program = parts[0].clone();
 *
 * So a shell-only prefix such as `exec` becomes the program name and the spawn
 * fails with `Unable to spawn exec because: No viable candidates found in PATH`.
 * That regression shipped in the Ubuntu branch as `-c "exec bash --rcfile ..."`.
 */

// The two shell files that hand a command line to AXS.
const AXS_SCRIPTS = ["init-sandbox.sh", "acode-launch.sh"];

// Builtins/keywords that are not standalone executables, so they can never
// resolve as `parts[0]` of an AXS command line.
const SHELL_ONLY_WORDS = new Set([
	".",
	"alias",
	"bg",
	"cd",
	"declare",
	"disown",
	"eval",
	"exec",
	"export",
	"fc",
	"fg",
	"hash",
	"jobs",
	"local",
	"read",
	"readonly",
	"return",
	"set",
	"shift",
	"source",
	"trap",
	"typeset",
	"ulimit",
	"umask",
	"unalias",
	"unset",
	"wait",
]);

/**
 * Extract the payload of every `... axs ... -c "<cmd>"` launch. Anchoring on
 * the axs argv position avoids matching unrelated `-c "..."` flags elsewhere in
 * shell text while still tolerating quoting (including `"$@"`) and line wrapping.
 */
function axsCommands(source) {
	const commands = [];
	const pattern =
		/\baxs"?(?:\s+(?:"[^"]*"|'[^']*'|[^\s"']+))*?\s+-c\s+"([^"]*)"/g;
	for (const match of source.matchAll(pattern)) {
		commands.push(match[1]);
	}
	return commands;
}

// Mirror AXS's own tokenization so the assertions match runtime behaviour.
const toProgramArgs = (cmd) => {
	const parts = cmd.split(/\s+/).filter(Boolean);
	return { program: parts[0], args: parts.slice(1) };
};

describe("AXS launch commands", () => {
	for (const script of AXS_SCRIPTS) {
		it(`spawns a real program for every -c payload in ${script}`, () => {
			const commands = axsCommands(readAsset(script));
			expect(
				commands.length,
				`no axs -c payload found in ${script}`,
			).toBeGreaterThan(0);

			for (const command of commands) {
				const { program, args } = toProgramArgs(command);

				expect(program, `empty program in -c "${command}"`).toBeTruthy();
				expect(
					SHELL_ONLY_WORDS.has(program),
					`-c "${command}" starts with the shell-only word "${program}"; ` +
						"AXS resolves the first token as the program to spawn",
				).toBe(false);
				// A program name must not carry shell syntax.
				expect(program).toMatch(/^[A-Za-z0-9_./+-]+$/);
				// Args, when present, are plain operands.
				for (const arg of args) {
					expect(arg).not.toMatch(/[\s]/);
				}
			}
		});
	}

	it("resolves the Ubuntu interactive shell to bash with the initrc", () => {
		const { program, args } = toProgramArgs(
			axsCommands(readAsset("acode-launch.sh"))[0],
		);
		expect(program).toBe("bash");
		expect(args).toContain("--rcfile");
		expect(args).toContain("/initrc");
		expect(args).toContain("-i");
	});
});
