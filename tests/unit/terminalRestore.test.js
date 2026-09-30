import { beforeEach, describe, expect, it, vi } from "vitest";

const { filesDir, state } = vi.hoisted(() => ({
	filesDir: "/data/user/0/com.foxdebug.acode/files",
	state: { commands: [], listing: "", extracted: [] },
}));

vi.mock("../../src/native/system", () => ({
	default: {
		getFilesDir: (success) => success(filesDir),
		fileExists: (path, countSymlinks, success) => {
			const exists =
				path.endsWith("aterm_backup.tar") ||
				path.startsWith(`${filesDir}/ubuntu`) ||
				path === `${filesDir}/.extracted` ||
				path === `${filesDir}/.configured` ||
				path === `${filesDir}/.downloaded`;
			success(exists ? 1 : 0);
		},
		extractTarXz: (source, destination, success) => {
			state.extracted.push({ source, destination });
			success();
		},
	},
}));

vi.mock("../../src/native/terminal/Executor", () => ({
	default: {
		BackgroundExecutor: {
			execute: vi.fn(async (command) => {
				state.commands.push(command);
				return String(command).includes("tar -tf") ? state.listing : "ok";
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

	it("extracts a compatible Ubuntu backup into the files directory", async () => {
		state.listing = ubuntuListing;

		await expect(Terminal.restore()).resolves.toBe("ok");

		expect(
			state.commands.some((command) => String(command).includes("rm -rf")),
		).toBe(true);
		expect(state.extracted).toEqual([
			{ source: `${filesDir}/aterm_backup.tar`, destination: filesDir },
		]);
	});
});
