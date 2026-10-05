import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `init-ubuntu.sh` launches `bash --rcfile /initrc -i`, so the prompt the user
 * ends up with is whatever `/initrc` leaves in PS1. The Ubuntu rootfs ships a
 * plain prompt in /etc/bash.bashrc and in the /etc/skel/.bashrc that gets copied
 * to $HOME, and those load on every interactive shell — which is why a prompt
 * set in `~/.bashrc` used to be overwritten by the Acode default.
 *
 * These tests run the real generated `/initrc` in bash against a stubbed rootfs,
 * so prompt precedence is asserted from observed shell behaviour rather than
 * from the text of the script.
 */

const LAUNCHER = "platforms/android/app/src/main/assets/init-ubuntu.sh";
const HARNESS_ROOT = path.join(os.tmpdir(), "acode-initrc-prompt-test");

// The plain prompt the Ubuntu rootfs files install.
const ROOTFS_PS1 = "\\u@\\h:\\w\\$ ";
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
		// HOME is forced to the device path, and /etc belongs to the machine
		// running the tests; both are redirected to the fixtures instead.
		.replace('export HOME="/public"', 'export HOME="$TEST_HOME"')
		.replace(/\/etc\/profile/g, "$TEST_ROOT/profile")
		.replace(/\/etc\/bash\.bashrc/g, "$TEST_ROOT/bash.bashrc");

const writeRootfsFixture = () => {
	fixtureRoot = path.join(HARNESS_ROOT, "rootfs");
	fs.mkdirSync(fixtureRoot, { recursive: true });

	// /etc/profile pulls in /etc/bash.bashrc on any interactive shell.
	fs.writeFileSync(
		path.join(fixtureRoot, "profile"),
		"[ -r /etc/bash.bashrc ] && . /etc/bash.bashrc\n",
	);
	// Ubuntu's /etc/bash.bashrc writes a plain prompt whenever the shell is
	// interactive, with no regard for the prompt that is already set.
	fs.writeFileSync(
		path.join(fixtureRoot, "bash.bashrc"),
		`[[ $- != *i* ]] && return\nPS1='${ROOTFS_PS1}'\n`,
	);
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
		expect(prompt).toContain("@localhost");
		expect(prompt).toContain("_PS1_PATH");
	});

	it("keeps the prompt a user set in ~/.bashrc", () => {
		expect(runPrompt("user", `PS1='${USER_PS1}'\n`)).toBe(USER_PS1);
	});

	it("still uses the Acode prompt when ~/.bashrc leaves PS1 as-is", () => {
		const userBashrc = 'PROMPT_COMMAND="history -a"\n';

		const prompt = runPrompt("untouched", userBashrc);

		expect(prompt).not.toBe(ROOTFS_PS1);
		expect(prompt).toContain("@localhost");
	});
});
