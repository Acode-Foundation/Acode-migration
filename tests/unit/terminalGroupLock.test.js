import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readShellFunctions } from "../helpers/initLauncher";

/**
 * Android group registration appends to /etc/group under a mkdir lock. A shell
 * killed with SIGKILL never runs its EXIT trap, so without an age check the lock
 * directory survives and every later launch gives up before registering, which
 * brings back the `groups: cannot find name for group ID` noise the pass exists
 * to remove.
 */

const HARNESS_ROOT = path.join(os.tmpdir(), "acode-group-lock-test");

let groupHandling = "";

const runRegistration = (name, { lock }) => {
	const root = path.join(HARNESS_ROOT, name);
	const lockPath = path.join(root, "group.lock");

	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, "group"), "root:x:0:\n");

	if (lock) {
		fs.mkdirSync(lockPath, { recursive: true });

		if (lock === "stale") {
			// Older than the grace period, which is the debris a killed shell leaves.
			const old = new Date(Date.now() - 600_000);

			fs.utimesSync(lockPath, old, old);
		}
	}

	const script = `ACODE_GROUP_FILE=${path.join(root, "group")}
ACODE_GROUP_LOCK=${lockPath}
ACODE_GROUP_LOCK_GRACE="5"
${groupHandling}
_add_android_group "${name}" "12345"
`;

	fs.writeFileSync(path.join(root, "run.sh"), script);
	execFileSync("bash", [path.join(root, "run.sh")], {
		encoding: "utf8",
		env: { PATH: process.env.PATH },
	});

	return {
		group: fs.readFileSync(path.join(root, "group"), "utf8"),
		lockExists: fs.existsSync(lockPath),
	};
};

beforeAll(() => {
	fs.rmSync(HARNESS_ROOT, { recursive: true, force: true });

	groupHandling = readShellFunctions(["_add_android_group"]);

	expect(groupHandling).toContain("_add_android_group()");
});

afterAll(() => {
	fs.rmSync(HARNESS_ROOT, { recursive: true, force: true });
});

describe("android group registration lock", () => {
	it("registers a missing group", () => {
		const { group, lockExists } = runRegistration("fresh", { lock: false });

		expect(group).toContain("fresh:x:12345:");
		expect(lockExists).toBe(false);
	});

	it("recovers from a lock left behind by a killed shell", () => {
		const { group, lockExists } = runRegistration("stale", { lock: "stale" });

		expect(group).toContain("stale:x:12345:");
		expect(lockExists).toBe(false);
	});

	it("still defers to a lock another shell is holding", () => {
		const { group, lockExists } = runRegistration("held", { lock: "held" });

		expect(group).not.toContain("held:x:12345:");
		expect(lockExists).toBe(true);
	});
});
