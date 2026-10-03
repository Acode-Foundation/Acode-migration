import { file, resolveLocalFileSystemURL } from "../file";
import { FileEntry } from "../file/entries";
import NativeFileReader from "../file/FileReader";
import http from "../http/advanced-http";
import runtime from "../runtime";
import system from "../system";
import Alpine from "./Alpine";
import Executor from "./Executor";

const AXS_READY_TIMEOUT = 60000;
const AXS_OUTPUT_LIMIT = 20;
const AXS_READY_PATTERN = /listening on/i;
const AXS_PORT_IN_USE_PATTERN =
	/port is already in use|eaddrinuse|address already in use/i;
const AXS_FATAL_PATTERNS = [
	/failed to spawn/i,
	/no viable candidates/i,
	/no such file or directory/i,
	/permission denied/i,
	/failed building the runtime/i,
	/exec format error/i,
];

let initScripts: Promise<{ initUbuntu: string; initSandbox: string }> | null =
	null;

/** Files a backup carries next to its rootfs; `isInstalled()` checks all of them. */
const TERMINAL_STATE_MARKERS = [
	".downloaded",
	".extracted",
	".configured",
	"axs",
];

/**
 * Single source of truth for what a terminal install owns. restore and uninstall
 * used to carry separate copies that had already drifted apart.
 */
const TERMINAL_STATE_PATHS = [
	"ubuntu",
	...TERMINAL_STATE_MARKERS,
	"axs.port",
	"libtalloc.so.2",
	"libproot-xed.so",
	"libproot.so",
	"libproot32.so",
];

function terminalStateCommand(action: string, exclude: string[] = []) {
	const targets = TERMINAL_STATE_PATHS.filter((path) => !exclude.includes(path))
		.map((path) => `"$PREFIX/${path}"`)
		.join(" ");
	if (!targets) return "echo ok";
	return `set -e\nfor item in ${targets}; do\n    ${action} "$item"\ndone\necho ok`;
}

function removeTerminalState(exclude: string[] = []) {
	return terminalStateCommand("rm -rf", exclude);
}

/**
 * Promotes a verified staging tree over the live install. The previous tree is
 * only discarded once the replacement is on disk, and is moved back when that
 * move fails, so a failed activation can never leave the user without a terminal.
 */
async function promoteStagedRootfs(stagingRootfs: string) {
	const result = await Executor.BackgroundExecutor.execute(
		`rm -rf "$PREFIX/ubuntu.old"\n` +
			`if [ -d "$PREFIX/ubuntu" ]; then mv "$PREFIX/ubuntu" "$PREFIX/ubuntu.old" || exit 1; fi\n` +
			`if ! mv "${stagingRootfs}" "$PREFIX/ubuntu"; then\n` +
			`    if [ -d "$PREFIX/ubuntu.old" ]; then mv "$PREFIX/ubuntu.old" "$PREFIX/ubuntu"; fi\n` +
			`    exit 1\n` +
			`fi\n` +
			`rm -rf "$PREFIX/ubuntu.old"\n` +
			`echo ok`,
	);
	if (!String(result).trim().endsWith("ok")) {
		throw new Error(`Failed to activate the extracted filesystem: ${result}`);
	}
}

/**
 * Moves the install markers a backup carries beside its rootfs into the live
 * install. Without them `isInstalled()` stays false after a restore, so the app
 * would treat an otherwise complete terminal as missing. The markers are created
 * when the backup predates one of them: the rootfs was verified usable already.
 */
async function promoteStagedState(stagingRoot: string) {
	const moves = TERMINAL_STATE_MARKERS.map(
		(marker) =>
			`if [ -e "${stagingRoot}/${marker}" ]; then rm -rf "$PREFIX/${marker}" && mv "${stagingRoot}/${marker}" "$PREFIX/${marker}" || exit 1; fi`,
	).join("\n");
	const result = await Executor.BackgroundExecutor.execute(
		`${moves}\n` +
			`mkdir -p "$PREFIX/.downloaded" "$PREFIX/.extracted" "$PREFIX/.configured"\n` +
			`echo ok`,
	);
	if (!String(result).trim().endsWith("ok")) {
		throw new Error(`Failed to activate the restored install state: ${result}`);
	}
}

/**
 * Removes a staging tree and everything the extractor may have left behind.
 */
async function removeStaging(stagingPath: string) {
	await Executor.BackgroundExecutor.execute(
		`rm -rf -- "${stagingPath}" && echo ok`,
	);
}

/**
 * A download that failed midway (an error page, a truncated file, a captive
 * portal) would otherwise extract to an empty rootfs that still passes every
 * directory-existence check. Verify the extraction produced a usable tree.
 */
async function assertUsableRootfs(directory: string) {
	const required = ["bin/sh", "etc/os-release"];
	for (const relative of required) {
		const exists = await new Promise<boolean>((resolve, reject) => {
			system.fileExists(
				`${directory}/${relative}`,
				false,
				(result) => resolve(Number(result) === 1),
				reject,
			);
		});
		if (!exists) {
			throw new Error(
				`Sandbox filesystem is incomplete: missing ${relative}. The download may have failed; retry the installation.`,
			);
		}
	}
}

const Terminal = {
	lastInstallError: "",
	lastStartError: "",
	lastStartOutput: "",
	legacyHomeMigrated: false,
	/**
	 * Starts the AXS environment by writing init scripts and executing the sandbox.
	 * @param {boolean} [installing=false] - Whether AXS is being started during installation.
	 * @param {Function} [logger=console.log] - Function to log standard output.
	 * @param {Function} [errorLogger=console.error] - Function to log errors.
	 * @param {boolean} [failsafe=false] - Start the sandbox in failsafe mode.
	 * @param {{port?: number, allowAnyOrigin?: boolean}} [options] - Listener overrides; the AXS origin allowlist stays in force unless `allowAnyOrigin` is true.
	 * @returns {Promise<boolean>} - True once the listener is ready (or the install exits 0).
	 */
	async startAxs(
		installing = false,
		logger = console.log,
		errorLogger = console.error,
		failsafe = false,
		options: { port?: number; allowAnyOrigin?: boolean } = {},
	) {
		const filesDir = await new Promise<string>((resolve, reject) => {
			system.getFilesDir(resolve, reject);
		});
		const failsafeArg = failsafe ? "--failsafe" : "";
		const { initUbuntu, initSandbox } = await this.readInitScripts();
		await this.migrateLegacyHome();
		const isFdroid = await Executor.execute("echo $FDROID");
		if (isFdroid !== "true") {
			//the symlink must be updated everytime because the symlinks to native libs can break after app updates
			await Executor.execute(
				"rm -f $PREFIX/axs && ln -s $NATIVE_DIR/libaxs.so $PREFIX/axs",
			);
		}
		await writeText(`${filesDir}/init-ubuntu.sh`, initUbuntu);
		await writeText(`${filesDir}/init-sandbox.sh`, initSandbox);

		const env = buildAxsEnv(options);

		if (installing) {
			return new Promise<boolean>((resolve) => {
				let lastError = "";
				Executor.start("sh", (type, data) => {
					logger(`${type} ${data}`);
					if (type === "stderr" && data) {
						lastError = lastError ? `${lastError}\n${data}` : data;
					}

					// Check for exit code during installation
					if (type === "exit") {
						const success = data === "0";
						if (!success) {
							this.lastInstallError = lastError
								? `Sandbox configuration failed with exit code ${data}: ${lastError}`
								: `Sandbox configuration failed with exit code ${data}`;
						}
						resolve(success);
					}
				})
					.then(async (uuid) => {
						await Executor.write(
							uuid,
							`${env}source ${filesDir}/init-sandbox.sh --installing ${failsafeArg}; exit`,
						);
					})
					.catch((error) => {
						const message = `Failed to start AXS: ${formatError(error)}`;
						this.lastInstallError = message;
						errorLogger(message);
						resolve(false);
					});
			});
		}

		return this.startServer(filesDir, env, failsafeArg, logger, errorLogger);
	},
	/**
	 * Reads the packaged init scripts once per app session.
	 */
	async readInitScripts() {
		if (!initScripts) {
			initScripts = Promise.all([
				readAsset("init-ubuntu.sh"),
				readAsset("init-sandbox.sh"),
			])
				.then(([initUbuntu, initSandbox]) => ({ initUbuntu, initSandbox }))
				.catch((error) => {
					initScripts = null;
					throw error;
				});
		}
		return initScripts;
	},
	/**
	 * Port the running AXS listener last recorded, if any. Survives app reloads
	 * because the guest writes it before the listener binds.
	 */
	async getPort() {
		try {
			const result = await Executor.BackgroundExecutor.execute(
				'cat "$PREFIX/axs.port" 2>/dev/null',
			);
			const port = Number.parseInt(String(result).trim(), 10);
			return Number.isFinite(port) && port > 0 && port <= 65535 ? port : null;
		} catch {
			return null;
		}
	},
	/**
	 * Starts the interactive AXS listener and resolves once it reports readiness.
	 */
	startServer(
		filesDir: string,
		env: string,
		failsafeArg: string,
		logger: (message: string) => void,
		errorLogger: (message: string) => void,
	) {
		this.lastStartError = "";
		this.lastStartOutput = "";
		const diagnostics = createStartDiagnostics();

		return new Promise<boolean>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (ready: boolean, error = "") => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				this.lastStartOutput = diagnostics.tail();
				this.lastStartError = ready
					? ""
					: error || diagnostics.error || this.lastStartOutput;
				resolve(ready);
			};

			timer = setTimeout(
				() =>
					finish(
						false,
						`AXS did not report readiness within ${AXS_READY_TIMEOUT}ms`,
					),
				AXS_READY_TIMEOUT,
			);

			Executor.start("sh", (type, data) => {
				diagnostics.feed(type, data);
				if (type === "exit") {
					finish(
						false,
						diagnostics.error ||
							diagnostics.tail() ||
							`AXS exited before becoming ready (code ${data})`,
					);
					return;
				}
				if (type === "stderr") {
					if (data) errorLogger(data);
				} else if (data) {
					logger(data);
				}
				if (AXS_READY_PATTERN.test(String(data ?? ""))) {
					finish(true);
				} else if (diagnostics.portInUse) {
					finish(false, diagnostics.error || diagnostics.tail());
				}
			})
				.then(async (uuid) => {
					await Executor.write(
						uuid,
						`${env}source ${filesDir}/init-sandbox.sh ${failsafeArg}; exit`,
					);
				})
				.catch((error) =>
					finish(false, `Failed to start AXS: ${formatError(error)}`),
				);
		});
	},
	/**
	 * Stops every running AXS session. `$PREFIX/pid` only ever holds the most
	 * recent session, so killing it alone left the other terminal tabs alive.
	 * @returns {Promise<void>}
	 */
	async stopAxs() {
		await Executor.execute(
			`for pidfile in $PREFIX/pid $PREFIX/pid.*; do\n` +
				`    [ -f "$pidfile" ] || continue\n` +
				`    pid="$(cat "$pidfile" 2>/dev/null)"\n` +
				`    case "$pid" in ''|*[!0-9]*) continue ;; esac\n` +
				`    kill -KILL "$pid" 2>/dev/null\n` +
				`done\n` +
				`pkill -KILL -f "$PREFIX/axs" 2>/dev/null\n` +
				`rm -f $PREFIX/pid $PREFIX/pid.*\n` +
				`true`,
		);
	},
	/**
	 * Checks if the AXS process is currently running.
	 * @returns {Promise<boolean>} - `true` if AXS is running, `false` otherwise.
	 */
	async isAxsRunning() {
		const filesDir = await new Promise<string>((resolve, reject) => {
			system.getFilesDir(resolve, reject);
		});
		const pidExists = await new Promise((resolve, reject) => {
			system.fileExists(
				`${filesDir}/pid`,
				false,
				(result) => {
					resolve(Number(result) === 1);
				},
				reject,
			);
		});
		if (!pidExists) return false;
		const result = await Executor.BackgroundExecutor.execute(
			`for pidfile in $PREFIX/pid $PREFIX/pid.*; do\n` +
				`    [ -f "$pidfile" ] || continue\n` +
				`    pid="$(cat "$pidfile" 2>/dev/null)"\n` +
				`    case "$pid" in ''|*[!0-9]*) continue ;; esac\n` +
				`    kill -0 "$pid" 2>/dev/null && { echo "true"; exit 0; }\n` +
				`done\n` +
				`echo "false"`,
		);
		return String(result).toLowerCase().includes("true");
	},
	/**
	 * Installs Ubuntu by downloading binaries and extracting the root filesystem.
	 * Also sets up additional dependencies for F-Droid variant.
	 * @param {Function} [logger=console.log] - Function to log standard output.
	 * @param {Function} [errorLogger=console.error] - Function to log errors.
	 * @returns {Promise<boolean>} - Returns true if installation completes with exit code 0
	 */
	async install(logger = console.log, errorLogger = console.error) {
		if (!(await this.isSupported())) return false;
		const isFdroid = await Executor.execute("echo $FDROID");
		this.lastInstallError = "";
		try {
			//cleanup before install
			await this.uninstall();
		} catch (e) {
			//suppress error
		}
		const filesDir = await new Promise<string>((resolve, reject) => {
			system.getFilesDir(resolve, reject);
		});
		const arch = await new Promise<string>((resolve, reject) => {
			system.getArch(resolve, reject);
		});
		try {
			const architectures = {
				"arm64-v8a": {
					libraryDirectory: "arm64",
					axsArchitecture: "arm64",
				},
				"armeabi-v7a": {
					libraryDirectory: "arm32",
					axsArchitecture: "armv7",
				},
				x86_64: {
					libraryDirectory: "x64",
					axsArchitecture: "x86_64",
				},
			};
			const architecture = architectures[arch as keyof typeof architectures];
			if (!architecture) {
				throw new Error(`Unsupported architecture: ${arch}`);
			}
			if (isFdroid === "true") {
				const buildUrl = (...parts: string[]) => parts.join("");
				const strings = {
					protocol: ["ht", "tps", ":", "//"],
					githubDomain: ["git", "hub", ".", "com"],
					acodeFoundation: ["Acode", "-", "Foundation"],
					acodeRepo: ["A", "code"],
					bajrangCoder: ["bajrang", "Coder"],
					acodexServer: ["acodex", "_", "server"],
				};
				const githubReleaseBase = buildUrl(
					...strings.protocol,
					...strings.githubDomain,
					"/",
					...strings.bajrangCoder,
					"/",
					...strings.acodexServer,
					"/releases/latest/download/",
				);
				const axsUrl = buildUrl(
					githubReleaseBase,
					"axs-pie-android-",
					architecture.axsArchitecture,
				);
				const ubuntuUrl = buildUrl(
					...strings.protocol,
					...strings.githubDomain,
					"/",
					...strings.acodeFoundation,
					"/",
					...strings.acodeRepo,
					"/raw/refs/heads/main/src/plugins/proot/assets/",
					architecture.libraryDirectory,
					"/ubuntu.rootfs",
				);
				logger("⬇️  Downloading sandbox filesystem...");
				await downloadFile(
					ubuntuUrl,
					file.dataDirectory + "ubuntu.tar.gz",
					"Sandbox filesystem",
				);
				logger("⬇️  Downloading axs...");
				await downloadFile(axsUrl, file.dataDirectory + "axs", "AXS");
				logger("✅  All downloads completed");
			} else {
				logger("📦  Extracting assets...");
				await new Promise((resolve, reject) => {
					system.extractAsset(
						`${architecture.libraryDirectory}/ubuntu.rootfs`,
						`${filesDir}/ubuntu.tar.gz`,
						resolve,
						(e) => {
							console.error(
								`Failed to extract ubuntu.tar.gz: ${formatError(e)}`,
							);
							reject(e);
						},
					);
				});
				try {
					await Executor.execute(
						"rm -f $PREFIX/axs && ln -s $NATIVE_DIR/libaxs.so $PREFIX/axs",
					);
				} catch (e) {
					errorLogger(`${formatError(e)}`);
				}
			}
			logger("📁  Setting up directories...");
			await ensureDir(`${filesDir}/.downloaded`);
			logger("📦  Extracting sandbox filesystem...");

			// Extract and verify into a staging tree first: replacing the live
			// install only after it is known-good keeps a failed extract from
			// destroying a working terminal. The rootfs archive stores its
			// contents at the archive root, so the staging directory itself
			// becomes $PREFIX/ubuntu.
			const stagingRoot = `${filesDir}/ubuntu.staging`;
			await removeStaging(stagingRoot);
			await ensureDir(stagingRoot);

			const rootfsArchive = `${filesDir}/ubuntu.tar.gz`;
			await new Promise((resolve, reject) => {
				system.extractTarArchive(
					rootfsArchive,
					stagingRoot,
					resolve,
					(error) => {
						reject(
							new Error(
								`Failed to extract the sandbox filesystem from ${rootfsArchive}: ${formatError(error)}`,
							),
						);
					},
				);
			});

			await assertUsableRootfs(stagingRoot);
			await promoteStagedRootfs(stagingRoot);

			logger("⚙️  Applying basic configuration...");
			await writeText(
				`${filesDir}/ubuntu/etc/resolv.conf`,
				`nameserver 8.8.4.4 \nnameserver 8.8.8.8`,
			);
			logger("✅  Extraction complete");
			await ensureDir(`${filesDir}/.extracted`);
			logger("⚙️  Updating sandbox environment...");
			const installResult = await this.startAxs(true, logger, errorLogger);
			if (!installResult) {
				throw new Error(
					this.lastInstallError || "Sandbox configuration failed.",
				);
			}
			return installResult;
		} catch (e) {
			const message = formatError(e);
			this.lastInstallError = message;
			errorLogger(`Installation failed: ${message}`);
			console.error("Installation failed:", e);
			return false;
		}
	},
	/**
	 * Checks if ubuntu is already installed.
	 * @returns {Promise<boolean>} - Returns true if all required files and directories exist.
	 */
	isInstalled() {
		return new Promise(async (resolve, reject) => {
			const filesDir = await new Promise<string>((resolve, reject) => {
				system.getFilesDir(resolve, reject);
			});
			const ubuntuExists = await new Promise((resolve, reject) => {
				system.fileExists(
					`${filesDir}/ubuntu`,
					false,
					(result) => {
						resolve(Number(result) === 1);
					},
					reject,
				);
			});
			const downloaded =
				ubuntuExists &&
				(await new Promise((resolve, reject) => {
					system.fileExists(
						`${filesDir}/.downloaded`,
						false,
						(result) => {
							resolve(Number(result) === 1);
						},
						reject,
					);
				}));
			const extracted =
				ubuntuExists &&
				(await new Promise((resolve, reject) => {
					system.fileExists(
						`${filesDir}/.extracted`,
						false,
						(result) => {
							resolve(Number(result) === 1);
						},
						reject,
					);
				}));
			const configured =
				ubuntuExists &&
				(await new Promise((resolve, reject) => {
					system.fileExists(
						`${filesDir}/.configured`,
						false,
						(result) => {
							resolve(Number(result) === 1);
						},
						reject,
					);
				}));
			resolve(ubuntuExists && downloaded && extracted && configured);
		});
	},
	/**
	 * Checks if the current device architecture is supported.
	 * @returns {Promise<boolean>} - `true` if architecture is supported, otherwise `false`.
	 */
	isSupported() {
		return new Promise((resolve, reject) => {
			system.getArch((arch) => {
				resolve(["arm64-v8a", "armeabi-v7a", "x86_64"].includes(arch));
			}, reject);
		});
	},
	/**
	 * Creates a backup of the Ubuntu Linux installation
	 * @async
	 * @function backup
	 * @description Creates a tar archive of the Ubuntu installation
	 * @returns {Promise<string>} Promise that resolves to the file URI of the created backup file (aterm_backup.tar)
	 * @throws {string} Rejects with "Ubuntu is not installed." if Ubuntu is not currently installed
	 * @throws {string} Rejects with command output if backup creation fails
	 * @example
	 * try {
	 *   const backupPath = await backup();
	 *   console.log(`Backup created at: ${backupPath}`);
	 * } catch (error) {
	 *   console.error(`Backup failed: ${error}`);
	 * }
	 */
	backup() {
		return new Promise(async (resolve, reject) => {
			if (!(await this.isInstalled())) {
				reject("Ubuntu is not installed.");
				return;
			}
			const cmd = `
            set -e
            INCLUDE_FILES="ubuntu .downloaded .extracted .configured axs"
            EXCLUDE="--exclude=ubuntu/data --exclude=ubuntu/system --exclude=ubuntu/vendor --exclude=ubuntu/sdcard --exclude=ubuntu/storage --exclude=ubuntu/public --exclude=ubuntu/apex --exclude=ubuntu/odm --exclude=ubuntu/product --exclude=ubuntu/system_ext --exclude=ubuntu/linkerconfig --exclude=ubuntu/proc --exclude=ubuntu/sys --exclude=ubuntu/dev --exclude=ubuntu/run --exclude=ubuntu/tmp"
            tar -cf "$PREFIX/aterm_backup.tar" -C "$PREFIX" $EXCLUDE $INCLUDE_FILES
            echo "ok"
            `;
			const result = await Executor.execute(cmd);
			if (result === "ok") {
				resolve(file.dataDirectory + "aterm_backup.tar");
			} else {
				reject(result);
			}
		});
	},
	/**
	 * Checks whether a terminal backup archive is available to restore.
	 * @returns {Promise<boolean>} - `true` if aterm_backup.tar exists.
	 */
	async isBackup() {
		const filesDir = await new Promise<string>((resolve, reject) => {
			system.getFilesDir(resolve, reject);
		});
		return fileExists(`${filesDir}/aterm_backup.tar`);
	},
	/**
	 * Detects which terminal layout a backup archive contains.
	 * Archives created by the older Alpine-based terminal contain only `alpine/`
	 * and cannot be used by the Ubuntu launcher.
	 * @param {string} backupPath - Absolute path to the backup archive.
	 * @returns {Promise<"ubuntu"|"legacy-alpine"|"unknown">} - Detected layout.
	 */
	async detectBackupLayout(backupPath: string) {
		const listing = await Executor.BackgroundExecutor.execute(
			`tar -tf '${backupPath}' 2>/dev/null | head -n 500 || true`,
		);

		let hasUbuntu = false;
		let hasAlpine = false;

		for (const rawEntry of String(listing).split("\n")) {
			const entry = rawEntry.trim().replace(/^\.\//, "");
			if (!entry) continue;

			const topLevel = entry.split("/")[0];
			if (topLevel === "ubuntu") hasUbuntu = true;
			else if (topLevel === "alpine") hasAlpine = true;
		}

		if (hasUbuntu) return "ubuntu";
		if (hasAlpine) return "legacy-alpine";
		return "unknown";
	},
	/**
	 * Restores Ubuntu Linux installation from a backup file
	 * @async
	 * @function restore
	 * @description Restores the Ubuntu installation from a previously created backup file (aterm_backup.tar).
	 * Archives created by the older Alpine-based terminal are rejected instead of being extracted
	 * into an installation the current launcher cannot use. For compatible archives this function
	 * stops any running Ubuntu processes, removes existing installation files, and extracts the
	 * backup to restore the previous state. The backup file must exist in the expected location.
	 * @returns {Promise<string>} Promise that resolves to "ok" when restoration completes successfully
	 * @throws {Error} Rejects with "Backup File does not exist" if aterm_backup.tar is not found
	 * @throws {Error} Rejects when the archive is a legacy Alpine backup or is not a valid Ubuntu backup
	 * @throws {Error} Rejects with command output if restoration fails
	 * @example
	 * try {
	 *   await restore();
	 *   console.log("Ubuntu installation restored successfully");
	 * } catch (error) {
	 *   console.error(`Restore failed: ${error}`);
	 * }
	 */
	async restore() {
		if (!(await this.isBackup())) {
			throw new Error("Backup File does not exist");
		}

		const filesDir = await new Promise<string>((resolve, reject) => {
			system.getFilesDir(resolve, reject);
		});

		const backupPath = `${filesDir}/aterm_backup.tar`;
		const layout = await this.detectBackupLayout(backupPath);

		if (layout === "legacy-alpine") {
			throw new Error(
				"This backup was created by the older Alpine-based terminal and cannot be restored on Ubuntu. Install the Ubuntu terminal and create a new backup.",
			);
		}

		if (layout !== "ubuntu") {
			throw new Error(
				"The selected file is not a valid Acode terminal backup.",
			);
		}

		if (await this.isAxsRunning()) {
			await this.stopAxs();
		}

		// Extract into staging and only then replace the live install. The old
		// code deleted the working rootfs before touching the archive, so a
		// truncated backup left the user with no terminal at all.
		const stagingRoot = `${filesDir}/ubuntu.staging`;
		await removeStaging(stagingRoot);
		await ensureDir(stagingRoot);

		try {
			await new Promise((resolve, reject) => {
				system.extractTarArchive(backupPath, stagingRoot, resolve, (error) => {
					reject(
						new Error(
							`Failed to extract backup ${backupPath}: ${formatError(error)}`,
						),
					);
				});
			});

			// A backup stores the tree under an `ubuntu/` prefix, unlike the
			// rootfs asset which stores its contents at the archive root.
			const stagedRootfs = `${stagingRoot}/ubuntu`;
			await assertUsableRootfs(stagedRootfs);

			// Swap the verified tree in first: the previous rootfs survives as
			// $PREFIX/ubuntu.old until the move succeeds. The backup's install
			// markers are promoted next, because they are what isInstalled()
			// checks; only legacy libraries and the stale port file are cleared.
			await promoteStagedRootfs(stagedRootfs);
			await promoteStagedState(stagingRoot);
			await Executor.BackgroundExecutor.execute(
				removeTerminalState(["ubuntu", ...TERMINAL_STATE_MARKERS]),
			);
		} catch (error) {
			await removeStaging(stagingRoot);
			throw new Error(formatError(error));
		}

		await removeStaging(stagingRoot);

		// Never report success unless the restored files form a usable Ubuntu install.
		if (!(await this.isInstalled())) {
			throw new Error(
				"The backup was extracted but the Ubuntu terminal installation is incomplete. Install the terminal again.",
			);
		}

		return "ok";
	},
	/**
	 * Uninstalls the Ubuntu Linux installation
	 * @async
	 * @function uninstall
	 * @description Completely removes the Ubuntu Linux installation from the device by deleting all
	 * Ubuntu-related files and directories. This function stops any running Ubuntu processes before
	 * removal. NOTE: This does not perform cleanup of $PREFIX
	 * @returns {Promise<string>} Promise that resolves to "ok" when uninstallation completes successfully
	 * @throws {string} Rejects with command output if uninstallation fails
	 * @example
	 * try {
	 *   await uninstall();
	 *   console.log("Ubuntu installation removed successfully");
	 * } catch (error) {
	 *   console.error(`Uninstall failed: ${error}`);
	 * }
	 */
	uninstall() {
		return new Promise(async (resolve, reject) => {
			if (await this.isAxsRunning()) {
				await this.stopAxs();
			}
			const cmd = `${removeTerminalState()}\nrm -rf -- "$PREFIX/ubuntu.staging" "$PREFIX/ubuntu.old"`;
			const result = await Executor.BackgroundExecutor.execute(cmd);
			if (String(result).includes("ok")) {
				resolve(result);
			} else {
				reject(result);
			}
		});
	},
	/**
	 * Migrates the legacy terminal home directories into public/MIGRATE.
	 * Older builds stored user files under alpine/home and alpine/root.
	 * After /home, /root and /public were merged into a single public
	 * directory, any files still left in the old locations are copied
	 * into public/MIGRATE (keeping their source structure) so nothing is
	 * hidden or lost. This is a no-op once the migration has run.
	 * @returns {Promise<void>}
	 */
	async migrateLegacyHome() {
		if (this.legacyHomeMigrated) return;
		try {
			const cmd = `
                MIGRATE="$PREFIX/public/MIGRATE"

                # Already migrated
                [ -e "$MIGRATE/.migrated" ] && exit 0

                if [ -d "$PREFIX/alpine/home" ] && [ -n "$(find "$PREFIX/alpine/home" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; then
                    mkdir -p "$MIGRATE/home"
                    cp -a "$PREFIX/alpine/home/." "$MIGRATE/home/" || exit 1
                fi

                if [ -d "$PREFIX/alpine/root" ] && [ -n "$(find "$PREFIX/alpine/root" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; then
                    mkdir -p "$MIGRATE/root"
                    cp -a "$PREFIX/alpine/root/." "$MIGRATE/root/" || exit 1
                fi

                # Written even when nothing needed copying, otherwise the scan
                # repeats on every launch for users with no legacy home.
                mkdir -p "$MIGRATE"
                touch "$MIGRATE/.migrated"
            `;
			await Executor.BackgroundExecutor.execute(cmd);
			this.legacyHomeMigrated = true;
		} catch (error) {
			console.error(
				"Failed to migrate legacy terminal home:",
				formatError(error),
			);
		}
	},
	formatError,
};
function buildAxsEnv(options: {
	port?: number;
	allowAnyOrigin?: boolean;
}): string {
	const assignments: string[] = [];
	const port = Number(options?.port);
	if (Number.isFinite(port) && port > 0 && port <= 65535) {
		assignments.push(`AXS_PORT=${Math.floor(port)}`);
	}
	if (options?.allowAnyOrigin === true) {
		assignments.push("AXS_ALLOW_ANY_ORIGIN=1");
	}
	return assignments.length ? `export ${assignments.join(" ")}; ` : "";
}

function createStartDiagnostics() {
	const lines: string[] = [];
	let error = "";

	const record = (text: string) => {
		if (!text.trim()) return;
		for (const line of text.split("\n")) {
			const trimmed = line.trimEnd();
			if (trimmed) lines.push(trimmed);
		}
		if (lines.length > AXS_OUTPUT_LIMIT) {
			lines.splice(0, lines.length - AXS_OUTPUT_LIMIT);
		}
	};

	return {
		feed(type: string, data: string) {
			const text = String(data ?? "");
			record(text);
			if (error) return;
			if (
				AXS_PORT_IN_USE_PATTERN.test(text) ||
				AXS_FATAL_PATTERNS.some((pattern) => pattern.test(text))
			) {
				error = text.trim();
			}
		},
		get error() {
			return error;
		},
		get portInUse() {
			return AXS_PORT_IN_USE_PATTERN.test(`${error}\n${lines.join("\n")}`);
		},
		tail() {
			return lines.join("\n");
		},
	};
}

function readAsset(assetPath: string, callback?: (text: string) => void) {
	const assetUrl = "file:///android_asset/" + assetPath;
	const promise = new Promise<string>((resolve, reject) => {
		resolveLocalFileSystemURL(
			assetUrl,
			(fileEntry) => {
				if (!(fileEntry instanceof FileEntry)) {
					reject(new Error("Asset is not a file"));
					return;
				}
				fileEntry.file((file) => {
					const reader = new NativeFileReader();
					reader.onloadend = () => resolve(String(reader.result));
					reader.onerror = () =>
						reject(reader.error || new Error(`Failed to read ${assetPath}`));
					reader.readAsText(file);
				}, reject);
			},
			reject,
		);
	});
	if (callback) {
		promise.then(callback).catch(console.error);
	}
	return promise;
}
function fileExists(path: string) {
	return new Promise((resolve, reject) => {
		system.fileExists(
			path,
			false,
			(result) => {
				resolve(Number(result) === 1);
			},
			reject,
		);
	});
}
async function ensureDir(path: string) {
	if (await fileExists(path)) return;
	await new Promise((resolve, reject) => {
		system.mkdirs(path, resolve, reject);
	});
}
function writeText(path: string, content: string) {
	return new Promise((resolve, reject) => {
		system.writeText(path, content, resolve, reject);
	});
}
function downloadFile(url: string, destination: string, label: string) {
	return new Promise((resolve, reject) => {
		http.downloadFile(url, {}, {}, destination, resolve, (error) =>
			reject(new Error(`${label} download failed: ${formatError(error)}`)),
		);
	});
}
function formatError(error: unknown) {
	if (error == null) return "Unknown error";
	if (error instanceof Error) return error.message || String(error);
	if (typeof error === "string") return error || "Unknown error";
	if (typeof error === "object") {
		const details = error as Record<string, unknown>;
		const parts = [];
		if (details.status != null) parts.push(`status ${details.status}`);
		if (details.error) parts.push(String(details.error));
		if (details.message) parts.push(String(details.message));
		if (details.exception) parts.push(String(details.exception));
		if (details.url) parts.push(`URL: ${details.url}`);
		if (parts.length) return parts.join(" - ");
		try {
			return JSON.stringify(error);
		} catch (jsonError) {
			return String(error);
		}
	}
	return String(error);
}
export default runtime.platformId === "ios"
	? Object.assign(Terminal, Alpine)
	: Terminal;
