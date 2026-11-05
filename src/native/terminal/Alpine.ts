import bridge from "../bridge";
import exec from "../exec";

const call = bridge("Alpine");

const Alpine = {
	lastInstallError: "",
	lastStartError: "",
	lastStartOutput: "",
	isSupported: () => call<boolean>("isSupported"),
	isInstalled: () => call<boolean>("isInstalled"),
	isAxsRunning: () => call<boolean>("isAxsRunning"),
	getPort: () => call<number | null>("getPort"),
	stopAxs: () => call<void>("stopAxs"),
	async startAxs(
		installing = false,
		logger = console.log,
		errorLogger = console.error,
		failsafe = false,
		options: { port?: number; allowAnyOrigin?: boolean } = {},
	): Promise<boolean> {
		if (installing) return this.install(logger, errorLogger);
		try {
			await call<void>("startAxs", [
				failsafe,
				options.port ?? null,
				options.allowAnyOrigin === true,
			]);
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.lastStartError = message;
			this.lastStartOutput = message;
			errorLogger(message);
			return false;
		}
	},
	install(logger = console.log, errorLogger = console.error): Promise<boolean> {
		this.lastInstallError = "";
		return new Promise((resolve) => {
			exec(
				({ type, data }: { type: string; data: string }) => {
					if (type === "exit") {
						if (data !== "0") {
							this.lastInstallError ||= `Alpine installation exited with status ${data}`;
						}
						resolve(data === "0");
					} else {
						if (type === "stderr") errorLogger(data);
						else logger(data);
					}
				},
				(error) => {
					this.lastInstallError = String(error);
					errorLogger(this.lastInstallError);
					resolve(false);
				},
				"Alpine",
				"install",
				[],
			);
		});
	},
	migrateLegacyHome: async () => {},
	backup: () => call<string>("backup"),
	restore: () => call<string>("restore"),
	uninstall: () => call<string>("uninstall"),
	clearBackup: () => call<void>("clearBackup"),
};

export default Alpine;
