import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readShellAssets, SHELL_ASSETS } from "../helpers/initLauncher";

/**
 * The launcher used to generate initrc, the acode CLI, the MOTD and the
 * Node.js hook from shell heredocs and gate rewrites on ACODE_GENERATED_VERSION.
 * The app owns those files now: it writes them from assets on every install and
 * launch, so the shell only has to read them.
 */

const ARTIFACTS = [
	{ asset: "acode-initrc", target: "initrc" },
	{ asset: "acode-cli", target: "usr/local/bin/acode" },
	{ asset: "acode-motd", target: "etc/acode_motd" },
	{
		asset: "acode-node-postinstall.sh",
		target: "usr/local/bin/node-postinstall.sh",
	},
	{ asset: "acode-apt-node-hook", target: "etc/apt/apt.conf.d/99node-hook" },
];

const { filesDir, assets, writes, FileEntry } = vi.hoisted(() => {
	const filesDir = "/data/user/0/com.foxdebug.acode/files";

	// Mirrors the FileEntry API readAsset walks: instanceof, file() and a URL
	// that identifies which asset was requested.
	class FileEntry {
		constructor(url) {
			this.url = url;
		}
		file(callback) {
			callback(this);
		}
	}

	return { filesDir, assets: new Map(), writes: [], FileEntry };
});

vi.mock("../../src/native/system", () => ({
	default: {
		getFilesDir: (success) => success(filesDir),
		fileExists: (target, _countSymlinks, success) =>
			success(String(target).startsWith(`${filesDir}/ubuntu`) ? 1 : 0),
		mkdirs: (_target, success) => success(),
		writeText: (target, content, success) => {
			writes.push({ target, content });
			success();
		},
	},
}));

vi.mock("../../src/native/terminal/Executor", () => ({
	default: {
		execute: vi.fn(async () => ""),
		write: vi.fn(async () => ""),
		start: vi.fn(async (_command, onData) => {
			// Report an immediate exit so startServer settles instead of waiting
			// for the readiness timeout.
			onData("exit", "0");
			return "uuid";
		}),
		BackgroundExecutor: { execute: vi.fn(async () => "ok") },
	},
}));

vi.mock("../../src/native/file", () => ({
	file: { dataDirectory: `${filesDir}/` },
	resolveLocalFileSystemURL: (url, success) => success(new FileEntry(url)),
}));

vi.mock("../../src/native/file/entries", () => ({ FileEntry }));

vi.mock("../../src/native/file/FileReader", () => ({
	default: class NativeFileReader {
		readAsText(file) {
			this.result = assets.get(file.url);
			this.onloadend();
		}
	},
}));

vi.mock("../../src/native/http/advanced-http", () => ({
	default: { downloadFile: () => {} },
}));

vi.mock("../../src/native/runtime", () => ({
	default: { platformId: "android" },
}));

vi.mock("../../src/native/terminal/Alpine", () => ({ default: {} }));

import Executor from "../../src/native/terminal/Executor";
import Terminal from "../../src/native/terminal/Terminal";

const ASSET_DIRECTORY = "platforms/android/app/src/main/assets";

const assetContent = (name) =>
	fs.readFileSync(path.join(ASSET_DIRECTORY, name), "utf8");

const writeFor = (target) => writes.find((write) => write.target === target);

beforeAll(() => {
	for (const name of [
		...SHELL_ASSETS,
		...ARTIFACTS.map((artifact) => artifact.asset),
	]) {
		assets.set(`file:///android_asset/${name}`, assetContent(name));
	}
});

beforeEach(() => {
	writes.length = 0;
});

describe("rootfs artifacts", () => {
	it("writes the launcher and every module it sources", async () => {
		await Terminal.writeInitScripts(filesDir);

		for (const name of SHELL_ASSETS) {
			expect(writeFor(`${filesDir}/${name}`)?.content, name).toBe(
				assetContent(name),
			);
		}
	});

	it("installs each artifact where the launcher reads it", async () => {
		await Terminal.syncRootfsArtifacts(filesDir);

		for (const { asset, target } of ARTIFACTS) {
			expect(writeFor(`${filesDir}/ubuntu/${target}`)?.content, target).toBe(
				assetContent(asset),
			);
		}
	});

	it("marks the executed artifacts executable", async () => {
		await Terminal.syncRootfsArtifacts(filesDir);

		const chmod = Executor.execute.mock.calls
			.map(([command]) => String(command))
			.find((command) => command.startsWith("chmod"));

		expect(chmod).toContain(`${filesDir}/ubuntu/usr/local/bin/acode`);
		expect(chmod).toContain(
			`${filesDir}/ubuntu/usr/local/bin/node-postinstall.sh`,
		);
	});

	it("refreshes the scripts and artifacts on a normal launch", async () => {
		// The launch path has to write them itself: nothing in the shell
		// generates or version-checks them any more.
		await Terminal.startAxs(false, () => {}, () => {});

		expect(writeFor(`${filesDir}/init-ubuntu.sh`)).toBeDefined();
		expect(writeFor(`${filesDir}/ubuntu/initrc`)).toBeDefined();
		expect(writeFor(`${filesDir}/ubuntu/usr/local/bin/acode`)).toBeDefined();
	});

	it("skips the artifacts when no rootfs is installed yet", async () => {
		await Terminal.syncRootfsArtifacts("/nonexistent");

		expect(writes).toEqual([]);
	});

	it("exposes the same shell content the helper reads", () => {
		// Guards the helper's concatenation against a file being dropped from
		// SHELL_ASSETS, which would silently stop the app writing it.
		expect(readShellAssets()).toContain('ACODE_INIT_DIR=$(dirname "$0")');
	});
});
