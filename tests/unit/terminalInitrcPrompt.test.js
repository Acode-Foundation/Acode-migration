import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `init-ubuntu.sh` launches `bash --rcfile /initrc -i`, so the prompt the user
 * ends up with is whatever `/initrc` leaves in PS1. Two rootfs files write a
 * prompt: /etc/bash.bashrc colors it for a 256-color TERM, while the stock
 * ~/.bashrc only colors TERM=xterm-color and so installs a plain prompt. Both
 * are rootfs defaults, and a prompt the user actually writes in ~/.bashrc has
 * to be told apart from them.
 *
 * These tests run the real generated `/initrc` in bash against a stubbed
 * rootfs, so prompt precedence is asserted from observed shell behaviour
 * rather than from the text of the script.
 */

const LAUNCHER = "platforms/android/app/src/main/assets/init-ubuntu.sh";
const HARNESS_ROOT = path.join(os.tmpdir(), "acode-initrc-prompt-test");

// What the rootfs installs: /etc/bash.bashrc colors the prompt for a 256-color
// TERM, the stock ~/.bashrc falls back to a plain one.
const ROOTFS_PS1 = "\\u@\\h:\\w\\$ ";
const ROOTFS_COLOR_PS1 =
	"\\[\\033[01;32m\\]\\u@\\h\\[\\033[00m\\]:\\[\\033[01;34m\\]\\w\\[\\033[00m\\]\\$ ";
// A prompt a user could reasonably put in ~/.bashrc.
const USER_PS1 = "\\[\\e[35m\\]user\\[\\e[0m\\]$ ";

let fixtureRoot = "";

const runPrompt = (name, userBashrc) => {
	const home = path.join(HARNESS_ROOT, name, "home");

	fs.mkdirSync(home, { recursive: true });
	fs.writeFileSync(path.join(home, ".bashrc"), userBashrc);

	const rcFile = path.join(HARNESS_ROOT, name, "initrc");
	fs.writeFileSync(rcFile, generatedInitrc());

	return execFileSync(
		"bash",
		["--rcfile", rcFile, "-i", "-c", 'printf "PS1=%s\\n" "$PS1"'],
		{
			encoding: "utf8",
			env: {
				PATH: process.env.PATH,
				TERM: "xterm-256color",
				TEST_HOME: home,
				TEST_ROOT: fixtureRoot,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	)
		.split("\n")
		.find((line) => line.startsWith("PS1="))
		.slice("PS1=".length);
};

const generatedInitrc = () =>
	fs
		.readFileSync(LAUNCHER, "utf8")
		.match(/cat > "\$PREFIX\/ubuntu\/initrc" <<'EOF'\n([\s\S]*?)\nEOF\n/)[1]
		// HOME is forced to the device path, and the system rc files belong to
		// the machine running the tests; all are redirected to the fixtures.
		.replace('export HOME="/public"', 'export HOME="$TEST_HOME"')
		.replace(/\/etc\/profile/g, "$TEST_ROOT/profile")
		.replace(/\/etc\/bash\.bashrc/g, "$TEST_ROOT/bash.bashrc")
		.replace(/\/etc\/skel\/\.bashrc/g, "$TEST_ROOT/skel.bashrc")
		.replace(/\/usr\/share\/base-files\/dot\.bashrc/g, "$TEST_ROOT/skel.bashrc");

// PROMPT_COMMAND runs before each prompt, so the marker for the previous
// command's exit status can only be observed after that command has run.
const markerAfter = (name, command) => {
	const home = path.join(HARNESS_ROOT, name, "home");

	fs.mkdirSync(home, { recursive: true });
	fs.writeFileSync(path.join(home, ".bashrc"), "");

	const rcFile = path.join(HARNESS_ROOT, name, "initrc");
	fs.writeFileSync(rcFile, generatedInitrc());

	const output = execFileSync("bash", ["--rcfile", rcFile, "-i"], {
		encoding: "utf8",
		input: `${command}\nprintf 'MARK=%s\\n' "$_PS1_MARK"\nexit\n`,
		env: {
			PATH: process.env.PATH,
			TERM: "xterm-256color",
			TEST_HOME: home,
			TEST_ROOT: fixtureRoot,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});

	return output
		.split("\n")
		.find((line) => line.startsWith("MARK="))
		.slice("MARK=".length);
};

// /etc/bash.bashrc ships color for a 256-color TERM.
const systemBashrc = () => `[[ $- != *i* ]] && return
case "$TERM" in
	xterm-color|*-256color) color_prompt=yes;;
esac
if [ "$color_prompt" = yes ]; then
	PS1='${ROOTFS_COLOR_PS1}'
else
	PS1='${ROOTFS_PS1}'
fi
`;

// The stock ~/.bashrc Ubuntu ships: it only colors TERM=xterm-color, so under
// the 256-color TERM the terminal uses it installs the plain prompt and an
// xterm title. That is still a rootfs default, not a user choice.
const stockBashrc = () => `[[ $- != *i* ]] && return
case "$TERM" in
	xterm-color) color_prompt=yes;;
esac
if [ "$color_prompt" = yes ]; then
	PS1='${ROOTFS_COLOR_PS1}'
else
	PS1='${ROOTFS_PS1}'
fi
case "$TERM" in
xterm*|rxvt*)
	PS1="\\[\\e]0;\\u@\\h: \\w\\a\\]$PS1"
	;;
esac
`;

const writeRootfsFixture = () => {
	fixtureRoot = path.join(HARNESS_ROOT, "rootfs");
	fs.mkdirSync(fixtureRoot, { recursive: true });

	// /etc/profile pulls in /etc/bash.bashrc on any interactive shell.
	fs.writeFileSync(
		path.join(fixtureRoot, "profile"),
		'[ -r "$TEST_ROOT/bash.bashrc" ] && . "$TEST_ROOT/bash.bashrc"\n',
	);
	fs.writeFileSync(path.join(fixtureRoot, "bash.bashrc"), systemBashrc());
	fs.writeFileSync(path.join(fixtureRoot, "skel.bashrc"), stockBashrc());
};

beforeAll(() => {
	fs.rmSync(HARNESS_ROOT, { recursive: true, force: true });
	writeRootfsFixture();
});

afterAll(() => {
	fs.rmSync(HARNESS_ROOT, { recursive: true, force: true });
});

describe("Ubuntu initrc prompt", () => {
	it("uses the colored Acode prompt when the user has not set one", () => {
		const prompt = runPrompt("default", "");

		expect(prompt).not.toBe(ROOTFS_PS1);
		expect(prompt).not.toBe(ROOTFS_COLOR_PS1);
		expect(prompt).toContain("@localhost");
		expect(prompt).toContain("_PS1_PATH");
	});

	it("keeps the prompt a user set in ~/.bashrc", () => {
		expect(runPrompt("user", `PS1='${USER_PS1}'\n`)).toBe(USER_PS1);
	});

	it("still uses the Acode prompt when ~/.bashrc leaves PS1 as-is", () => {
		const userBashrc = 'PROMPT_COMMAND="history -a"\n';

		const prompt = runPrompt("untouched", userBashrc);

		expect(prompt).toContain("@localhost");
		expect(prompt).toContain("_PS1_PATH");
	});

	it("restores the Acode prompt over the stock ~/.bashrc", () => {
		const prompt = runPrompt("stock", stockBashrc());

		expect(prompt).toContain("@localhost");
		expect(prompt).toContain("_PS1_PATH");
	});

	it("shows the red failure marker after a failing command", () => {
		expect(markerAfter("failed", "false")).toContain("[31m");
	});

	it("keeps the plain marker after a successful command", () => {
		expect(markerAfter("succeeded", "true")).toBe("$");
	});
});
