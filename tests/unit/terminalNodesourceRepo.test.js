import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readShellFunctions } from "../helpers/initLauncher";

/**
 * Ubuntu 24.04 ships nodejs 18, which is past end of life, so the install path
 * registers the NodeSource repository before fetching package lists. The setup
 * has to stay best effort: an offline install must not fail because the
 * repository could not be reached, and a second install must not repeat work
 * that is already current.
 */

const HARNESS_ROOT = path.join(os.tmpdir(), "acode-nodesource-test");
const KEY_URL = "https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key";

let repoSetup = "";

// Every external tool the setup reaches for, recorded and steered by env vars.
const fakes = {
	dpkg: 'echo "$ACODE_TEST_ARCH"',
	curl: 'echo "$@" >> "$ACODE_TEST_LOG"; cat "$ACODE_TEST_KEY"',
	gpg: 'echo "$@" >> "$ACODE_TEST_LOG"; cat > "$ACODE_TEST_KEY_OUT"',
	"apt-get": 'echo "$@" >> "$ACODE_TEST_LOG"; exit "${ACODE_TEST_APT_STATUS:-0}"',
	chmod: 'echo "$@" >> "$ACODE_TEST_LOG"',
	grep: 'exec /usr/bin/grep "$@"',
	awk: 'exec /usr/bin/awk "$@"',
};

const runSetup = ({ name, arch = "arm64", aptStatus = "0", existingSources = "" }) => {
	const root = path.join(HARNESS_ROOT, name);
	const bin = path.join(root, "bin");

	fs.mkdirSync(bin, { recursive: true });

	for (const [tool, body] of Object.entries(fakes)) {
		const file = path.join(bin, tool);

		fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
		fs.chmodSync(file, 0o755);
	}

	const log = path.join(root, "calls.log");
	const key = path.join(root, "key.asc");
	const sources = path.join(root, "sources.list.d", "nodesource.sources");
	const keyring = path.join(root, "share", "keyrings", "nodesource.gpg");
	const preferences = path.join(root, "preferences.d");

	fs.writeFileSync(key, "-----BEGIN PGP PUBLIC KEY BLOCK-----\nfake\n");
	fs.writeFileSync(log, "");

	if (existingSources) {
		fs.mkdirSync(path.dirname(sources), { recursive: true });
		fs.writeFileSync(sources, existingSources);
	}

	const script = `export ACODE_NODE_MAJOR="26.x"
export ACODE_APT_SOURCES=${sources}
export ACODE_APT_KEYRING=${keyring}
export ACODE_APT_PREFERENCES=${preferences}
export ACODE_TEST_LOG=${log}
export ACODE_TEST_ARCH=${arch}
export ACODE_TEST_APT_STATUS=${aptStatus}
export ACODE_TEST_KEY=${key}
export ACODE_TEST_KEY_OUT=${path.join(root, "dearmored.gpg")}
log_step() { :; }
log_ok() { :; }
log_warn() { :; }
${repoSetup}
configure_nodesource_repo
`;

	fs.writeFileSync(path.join(root, "run.sh"), script);

	execFileSync("bash", [path.join(root, "run.sh")], {
		encoding: "utf8",
		env: { PATH: `${bin}:/usr/bin:/bin` },
	});

	return {
		calls: fs.readFileSync(log, "utf8"),
		keyring: fs.existsSync(path.join(root, "dearmored.gpg"))
			? fs.readFileSync(path.join(root, "dearmored.gpg"), "utf8")
			: null,
		sources: fs.existsSync(sources) ? fs.readFileSync(sources, "utf8") : null,
		preference: fs.existsSync(path.join(preferences, "nodejs"))
			? fs.readFileSync(path.join(preferences, "nodejs"), "utf8")
			: null,
	};
};

beforeAll(() => {
	fs.rmSync(HARNESS_ROOT, { recursive: true, force: true });

	repoSetup = readShellFunctions(["configure_nodesource_repo"]);

	expect(repoSetup).toContain("configure_nodesource_repo()");
});

afterAll(() => {
	fs.rmSync(HARNESS_ROOT, { recursive: true, force: true });
});

describe("nodesource repository setup", () => {
	it("registers the repository with the arm64 architecture", () => {
		const { calls, sources, preference, keyring } = runSetup({ name: "arm64" });

		expect(calls).toContain(
			"install -y --no-install-recommends ca-certificates curl gnupg",
		);
		// A fresh rootfs has empty package lists, so the prerequisites install
		// has to follow an update or apt reports "Unable to locate package curl".
		expect(calls.indexOf("update")).toBeLessThan(
			calls.indexOf("install -y --no-install-recommends"),
		);
		expect(calls).toContain(`-fsSL ${KEY_URL}`);
		expect(calls).toContain("update");
		// The sources directory has to be created first: without it this write
		// fails silently and apt never learns about the repository.
		expect(sources).toContain("URIs: https://deb.nodesource.com/node_26.x");
		expect(sources).toContain("Suites: nodistro");
		expect(sources).toContain("Architectures: arm64");
		expect(sources).toContain("Signed-By:");
		expect(preference).toContain("Pin: origin deb.nodesource.com");
		expect(preference).toContain("Pin-Priority: 600");
		expect(keyring).toContain("BEGIN PGP PUBLIC KEY BLOCK");
	});

	it("keeps Ubuntu's nodejs on an architecture NodeSource does not build", () => {
		const { calls, sources } = runSetup({ name: "riscv64", arch: "riscv64" });

		expect(sources).toBeNull();
		expect(calls).not.toContain("curl");
	});

	it("skips the repository on 32-bit arm, where NodeSource 26.x has no packages", () => {
		const { calls, sources, preference } = runSetup({
			name: "armhf",
			arch: "armhf",
		});

		expect(sources).toBeNull();
		expect(preference).toBeNull();
		expect(calls).not.toContain("curl");
	});

	it("stays non-fatal when the repository cannot be reached", () => {
		const { sources } = runSetup({ name: "offline", aptStatus: "100" });

		// The key and the sources file need curl, which the failed install did
		// not provide, so the setup backs out instead of failing the install.
		expect(sources).toBeNull();
	});

	it("does not redo the registration when the source list already exists", () => {
		const current = "Types: deb\nURIs: https://deb.nodesource.com/node_26.x\n";

		const { calls, sources } = runSetup({
			name: "current",
			existingSources: current,
		});

		// Only the list refresh remains: no key download, no re-install.
		expect(calls).not.toContain("curl");
		expect(calls).not.toContain("ca-certificates");
		expect(calls).toContain("update");
		expect(sources).toBe(current);
	});
});
