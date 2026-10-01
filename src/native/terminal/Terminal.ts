import { file, resolveLocalFileSystemURL } from "../file";
import { FileEntry } from "../file/entries";
import NativeFileReader from "../file/FileReader";
import http from "../http/advanced-http";
import runtime from "../runtime";
import system from "../system";
import Alpine from "./Alpine";
import Executor from "./Executor";

const Terminal = {
	lastInstallError: "",
	legacyHomeMigrated: false,
	/**
	 * Starts the AXS environment by writing init scripts and executing the sandbox.
	 * @param {boolean} [installing=false] - Whether AXS is being started during installation.
	 * @param {Function} [logger=console.log] - Function to log standard output.
	 * @param {Function} [errorLogger=console.error] - Function to log errors.
	 * @returns {Promise<boolean>} - Returns true if installation completes with exit code 0, void if not installing
	 */
	async startAxs(
		installing = false,
		logger = console.log,
		errorLogger = console.error,
		failsafe = false,
	) {
		const filesDir = await new Promise<string>((resolve, reject) => {
			system.getFilesDir(resolve, reject);
		});
		const failsafeArg = failsafe ? "--failsafe" : "";
		const [initUbuntu, initSandbox] = await Promise.all([
			readAsset("init-ubuntu.sh"),
			readAsset("init-sandbox.sh"),
		]);
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
		if (installing) {
			return new Promise((resolve, reject) => {
				let lastError = "";
				Executor.start("sh", (type, data) => {
					//console[type === "stderr" ? "error" : "log"](`[AXS] ${data}`);
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
							`source ${filesDir}/init-sandbox.sh ${installing ? "--installing" : ""} ${failsafeArg}; exit`,
						);
					})
					.catch((error) => {
						const message = `Failed to start AXS: ${formatError(error)}`;
						this.lastInstallError = message;
						errorLogger(message);
						resolve(false);
					});
			});
		} else {
			try {
				const uuid = await Executor.start("sh", (type, data) => {
					//console[type === "stderr" ? "error" : "log"](`[AXS] ${data}`);
					logger(`${type} ${data}`);
				});
				await Executor.write(
					uuid,
					`source ${filesDir}/init-sandbox.sh ${installing ? "--installing" : ""} ${failsafeArg}; exit`,
				);
			} catch (error) {
				const message = `Failed to start AXS: ${formatError(error)}`;
				errorLogger(message);
				throw new Error(message);
			}
		}
	},
	/**
	 * Stops the AXS process by forcefully killing it.
	 * @returns {Promise<void>}
	 */
	async stopAxs() {
		await Executor.execute(`kill -KILL $(cat $PREFIX/pid)`);
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
			`kill -0 $(cat $PREFIX/pid) 2>/dev/null && echo "true" || echo "false"`,
		);
		return String(result).toLowerCase() === "true";
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
			const ubuntuDir = `${filesDir}/ubuntu`;
			await ensureDir(ubuntuDir);
			logger("📦  Extracting sandbox filesystem...");
			await new Promise((resolve, reject) => {
				system.extractTarXz(
					`${filesDir}/ubuntu.tar.gz`,
					ubuntuDir,
					resolve,
					(e) => {
						reject(e);
					},
				);
			});
			logger("⚙️  Applying basic configuration...");
			await writeText(
				`${ubuntuDir}/etc/resolv.conf`,
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

		const cmd = `
        set -e

        INCLUDE_FILES="$PREFIX/ubuntu $PREFIX/.downloaded $PREFIX/.extracted $PREFIX/.configured $PREFIX/axs"

        for item in $INCLUDE_FILES; do
            rm -rf -- "$item"
        done
        echo "ok"
        `;

		const result = await Executor.BackgroundExecutor.execute(cmd);
		if (result !== "ok") {
			throw new Error(result);
		}

		try {
			await new Promise((resolve, reject) => {
				system.extractTarXz(backupPath, filesDir, resolve, (error) => {
					reject(new Error(`Failed to extract backup: ${formatError(error)}`));
				});
			});
		} catch (error) {
			throw new Error(formatError(error));
		}

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
			const cmd = `
            set -e

            INCLUDE_FILES="$PREFIX/ubuntu $PREFIX/.downloaded $PREFIX/.extracted $PREFIX/.configured $PREFIX/axs $PREFIX/libtalloc.so.2 $PREFIX/libproot-xed.so $PREFIX/libproot.so $PREFIX/libproot32.so"

            for item in $INCLUDE_FILES; do
                rm -rf -- "$item"
            done

            echo "ok"
            `;
			const result = await Executor.BackgroundExecutor.execute(cmd);
			if (result === "ok") {
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

                COPIED=false

                if [ -d "$PREFIX/alpine/home" ] && [ -n "$(find "$PREFIX/alpine/home" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; then
                    mkdir -p "$MIGRATE/home"
                    if cp -a "$PREFIX/alpine/home/." "$MIGRATE/home/"; then
                        COPIED=true
                    else
                        exit 1
                    fi
                fi

                if [ -d "$PREFIX/alpine/root" ] && [ -n "$(find "$PREFIX/alpine/root" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; then
                    mkdir -p "$MIGRATE/root"
                    if cp -a "$PREFIX/alpine/root/." "$MIGRATE/root/"; then
                        COPIED=true
                    else
                        exit 1
                    fi
                fi

                # Mark as migrated so this only runs once
                if [ "$COPIED" = "true" ]; then
                    touch "$MIGRATE/.migrated"
                fi
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
