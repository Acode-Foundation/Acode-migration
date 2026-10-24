import { beforeEach, describe, expect, it, vi } from "vitest";

const { filesDir, state, simulateFilesystem } = vi.hoisted(() => {
	const filesDir = "/data/user/0/com.foxdebug.acode/files";
	const state = {
		commands: [],
		listing: "",
		extracted: [],
		extractFails: false,
		existing: new Set(),
	};

	/**
	 * Mirrors the file operations Terminal.restore() issues so a regression that
	 * deletes the install markers shows up as a failing isInstalled() check.
	 */
	function simulateFilesystem(command) {
		if (!command.includes("$PREFIX")) return;

		if (/for item in[\s\S]*?rm -rf "\$item"/.test(command)) {
			const list = command.slice(
				command.indexOf("for item in"),
				command.indexOf("; do"),
			);
			for (const [, name] of list.matchAll(/\$PREFIX\/([A-Za-z0-9._-]+)/g)) {
				state.existing.delete(`${filesDir}/${name}`);
			}
		}

		for (const [, name] of command.matchAll(
			/rm -rf "\$PREFIX\/([A-Za-z0-9._-]+)"/g,
		)) {
			state.existing.delete(`${filesDir}/${name}`);
		}
		for (const [, name] of command.matchAll(
			/mv "[^"]*\/([A-Za-z0-9._-]+)" "\$PREFIX\/([A-Za-z0-9._-]+)"/g,
		)) {
			state.existing.add(`${filesDir}/${name}`);
		}
		for (const [, list] of command.matchAll(/mkdir -p ([^\n]*)/g)) {
			for (const [, name] of list.matchAll(/\$PREFIX\/([A-Za-z0-9._-]+)/g)) {
				state.existing.add(`${filesDir}/${name}`);
			}
		}
	}

	return { filesDir, state, simulateFilesystem };
});

vi.mock("../../src/native/system", () => ({
	default: {
		getFilesDir: (success) => success(filesDir),
		fileExists: (path, countSymlinks, success) => {
			const exists =
				state.existing.has(path) ||
				path.endsWith("aterm_backup.tar") ||
				path.startsWith(`${filesDir}/ubuntu.staging`);
			success(exists ? 1 : 0);
		},
		extractTarArchive: (source, destination, success, error) => {
			state.extracted.push({ source, destination });
			if (state.extractFails) {
				error("simulated extraction failure");
				return;
			}
			// A backup stores the rootfs and the install markers at its root.
			for (const entry of [
				"ubuntu",
				".downloaded",
				".extracted",
				".configured",
				"axs",
			]) {
				state.existing.add(`${destination}/${entry}`);
			}
			success();
		},
	},
}));

vi.mock("../../src/native/terminal/Executor", () => ({
	default: {
		BackgroundExecutor: {
			execute: vi.fn(async (command) => {
				state.commands.push(command);
				if (String(command).includes("tar -tf")) return state.listing;
				simulateFilesystem(String(command));
				return "ok";
			}),
		},
	},
}));

vi.mock("../../src/native/runtime", () => ({
	default: { platformId: "android" },
}));

vi.mock("../../src/native/file", () => ({
	file: { dataDirectory: `${filesDir}/` },
	resolveLocalFileSystemURL: () => {},
}));

vi.mock("../../src/native/file/entries", () => ({
	FileEntry: class FileEntry {},
}));

vi.mock("../../src/native/file/FileReader", () => ({
	default: class NativeFileReader {},
}));

vi.mock("../../src/native/http/advanced-http", () => ({
	default: { downloadFile: () => {} },
}));

vi.mock("../../src/native/terminal/Alpine", () => ({ default: {} }));

import Terminal from "../../src/native/terminal/Terminal";

const ubuntuListing = [
	"ubuntu/",
	"ubuntu/bin/",
	"ubuntu/bin/bash",
	"ubuntu/etc/resolv.conf",
	".downloaded",
	".extracted",
	".configured",
	"axs",
].join("\n");

const alpineListing = [
	"alpine/",
	"alpine/bin/",
	"alpine/bin/busybox",
	".downloaded",
	".extracted",
	".configured",
	"axs",
].join("\n");

describe("terminal backup restore", () => {
	beforeEach(() => {
		state.commands.length = 0;
		state.listing = "";
		state.extracted.length = 0;
		state.extractFails = false;
		state.existing = new Set([
			`${filesDir}/ubuntu`,
			`${filesDir}/.downloaded`,
			`${filesDir}/.extracted`,
			`${filesDir}/.configured`,
		]);
	});

	it("rejects a legacy Alpine backup before touching the current install", async () => {
		state.listing = alpineListing;

		await expect(Terminal.restore()).rejects.toThrow(/Alpine/i);

		// The incompatible archive must be detected before any removal happens.
		expect(
			state.commands.some((command) => String(command).includes("rm -rf")),
		).toBe(false);
		expect(state.extracted).toHaveLength(0);
	});

	it("rejects an archive that is not a terminal backup", async () => {
		state.listing = "some/random/file.txt";

		await expect(Terminal.restore()).rejects.toThrow(/not a valid/i);
		expect(state.extracted).toHaveLength(0);
	});

	it("extracts a compatible backup into a staging tree, then activates it", async () => {
		state.listing = ubuntuListing;

		await expect(Terminal.restore()).resolves.toBe("ok");

		expect(state.extracted).toEqual([
			{
				source: `${filesDir}/aterm_backup.tar`,
				destination: `${filesDir}/ubuntu.staging`,
			},
		]);

		// The live rootfs is promoted only after the staged tree is verified.
		const promoteIndex = state.commands.findIndex(
			(command) =>
				String(command).includes("mv") && String(command).includes("ubuntu"),
		);
		expect(promoteIndex).toBeGreaterThan(-1);

		// The cleanup must not delete the rootfs or the markers that were just
		// promoted, otherwise isInstalled() fails after a successful restore.
		const cleanup = state.commands.find(
			(command) =>
				String(command).includes("for item in") &&
				String(command).includes("rm -rf"),
		);
		expect(cleanup).toBeDefined();
		expect(String(cleanup)).not.toContain('"$PREFIX/ubuntu"');
		for (const marker of [".downloaded", ".extracted", ".configured"]) {
			expect(String(cleanup), marker).not.toContain(`"$PREFIX/${marker}"`);
			expect(state.existing.has(`${filesDir}/${marker}`), marker).toBe(true);
		}
	});

	it("keeps the existing install when extraction fails", async () => {
		state.listing = ubuntuListing;
		state.extractFails = true;

		await expect(Terminal.restore()).rejects.toThrow(/extract/i);

		// Neither the rootfs swap nor the state cleanup may run: a corrupt
		// backup must never leave the user without a terminal. Staging-only
		// removal is expected and fine.
		const mutating = state.commands.filter(
			(command) =>
				/(\bmv\b|\brm -rf\b)/.test(String(command)) &&
				!String(command).includes("ubuntu.staging"),
		);
		expect(mutating).toEqual([]);
	});
});
