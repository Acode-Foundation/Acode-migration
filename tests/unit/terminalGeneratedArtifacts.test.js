import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readLauncher, readShellFunctions } from "../helpers/initLauncher";

/**
 * The rootfs keeps its own copy of initrc, the acode CLI and the MOTD, so they
 * are rewritten on the install path, gated by ACODE_GENERATED_VERSION. A normal
 * launch must leave them alone: it only boots AXS and must not touch rootfs
 * state beyond the group and Node hook passes.
 */

const HARNESS_ROOT = path.join(os.tmpdir(), "acode-generated-artifacts-test");

let versionGate = "";

const runRefresh = ({ versionFile, ubuntu, prefix, writeMarker = false }) => {
	const script = `INSTALLING=false
PREFIX=${prefix}
ACODE_GENERATED_VERSION="4"
ACODE_VERSION_FILE=${versionFile}
ACODE_GROUP_LOCK=${path.join(prefix, "group.lock")}
log_step() { :; }
log_ok() { :; }
${versionGate}
refresh_generated_artifacts
${writeMarker ? "write_version_marker" : ""}
`;

	fs.writeFileSync(path.join(prefix, "run.sh"), script);

	execFileSync("bash", [path.join(prefix, "run.sh")], {
		encoding: "utf8",
		env: { PATH: process.env.PATH },
	});
};

const layout = (name) => {
	const prefix = path.join(HARNESS_ROOT, name);
	const ubuntu = path.join(prefix, "ubuntu");

	return {
		prefix,
		ubuntu,
		versionFile: path.join(prefix, "etc", "acode", "generated.version"),
	};
};

const writeStaleArtifacts = (ubuntu) => {
	fs.mkdirSync(path.join(ubuntu, "etc"), { recursive: true });
	fs.mkdirSync(path.join(ubuntu, "usr", "local", "bin"), { recursive: true });
	fs.writeFileSync(path.join(ubuntu, "etc", "acode_motd"), "stale motd\n");
	fs.writeFileSync(
		path.join(ubuntu, "usr", "local", "bin", "acode"),
		"#!/bin/bash\necho stale\n",
	);
	fs.writeFileSync(path.join(ubuntu, "initrc"), "stale initrc\n");
};

beforeAll(() => {
	fs.rmSync(HARNESS_ROOT, { recursive: true, force: true });

	versionGate = readShellFunctions([
		"is_current_version",
		"needs_refresh",
		"write_version_marker",
		"refresh_generated_artifacts",
	]);

	expect(versionGate).toContain("refresh_generated_artifacts()");
});

afterAll(() => {
	fs.rmSync(HARNESS_ROOT, { recursive: true, force: true });
});

describe("generated rootfs artifacts", () => {
	it("rewrites stale artifacts when the install is on an older version", () => {
		const { prefix, ubuntu, versionFile } = layout("stale");

		fs.mkdirSync(path.dirname(versionFile), { recursive: true });
		writeStaleArtifacts(ubuntu);
		// The previous release left its own version behind.
		fs.writeFileSync(versionFile, "3\n");

		runRefresh({ versionFile, ubuntu, prefix });

		expect(fs.readFileSync(path.join(ubuntu, "initrc"), "utf8")).toContain(
			"_ACODE_ROOTFS_PS1",
		);
		expect(
			fs.readFileSync(path.join(ubuntu, "usr", "local", "bin", "acode"), "utf8"),
		).toContain("open_in_acode");
		expect(
			fs.readFileSync(path.join(ubuntu, "etc", "acode_motd"), "utf8"),
		).toContain("Welcome to Ubuntu Linux in Acode!");
	});

	it("rewrites an artifact that disappeared even on a current version", () => {
		const { prefix, ubuntu, versionFile } = layout("missing");

		fs.mkdirSync(path.dirname(versionFile), { recursive: true });
		fs.mkdirSync(path.join(ubuntu, "etc"), { recursive: true });
		fs.writeFileSync(versionFile, "4\n");
		fs.writeFileSync(path.join(ubuntu, "initrc"), "current initrc\n");

		runRefresh({ versionFile, ubuntu, prefix });

		expect(
			fs.readFileSync(path.join(ubuntu, "etc", "acode_motd"), "utf8"),
		).toContain("Welcome to Ubuntu Linux in Acode!");
	});

	it("leaves artifacts alone once the version marker is current", () => {
		const { prefix, ubuntu, versionFile } = layout("current");
		const current = {
			motd: "current motd\n",
			acode: "#!/bin/bash\necho current\n",
			// The marker is published after a successful refresh, which is what
			// makes this install land here next time.
			initrc: "# acode-generated-version: 4\ncurrent initrc\n",
		};

		fs.mkdirSync(path.dirname(versionFile), { recursive: true });
		fs.mkdirSync(path.join(ubuntu, "etc"), { recursive: true });
		fs.mkdirSync(path.join(ubuntu, "usr", "local", "bin"), { recursive: true });

		fs.writeFileSync(path.join(ubuntu, "etc", "acode_motd"), current.motd);
		fs.writeFileSync(
			path.join(ubuntu, "usr", "local", "bin", "acode"),
			current.acode,
		);
		fs.writeFileSync(path.join(ubuntu, "initrc"), current.initrc);

		// First pass is stale, so it rewrites and the marker is written after,
		// exactly as the install path orders it.
		runRefresh({ versionFile, ubuntu, prefix, writeMarker: true });
		fs.writeFileSync(path.join(ubuntu, "etc", "acode_motd"), current.motd);
		fs.writeFileSync(
			path.join(ubuntu, "usr", "local", "bin", "acode"),
			current.acode,
		);
		fs.writeFileSync(path.join(ubuntu, "initrc"), current.initrc);

		runRefresh({ versionFile, ubuntu, prefix });

		expect(fs.readFileSync(path.join(ubuntu, "etc", "acode_motd"), "utf8")).toBe(
			current.motd,
		);
		expect(fs.readFileSync(path.join(ubuntu, "initrc"), "utf8")).toBe(
			current.initrc,
		);
	});

	it("does not touch generated artifacts on a normal launch", () => {
		const source = readLauncher();
		const call = "refresh_generated_artifacts";
		// Everything after the last call is launched for every terminal, not
		// only while installing.
		const launchPath = source.slice(source.lastIndexOf(call) + call.length);

		expect(launchPath).not.toContain(call);
		expect(launchPath).not.toContain("write_version_marker");
	});
});
