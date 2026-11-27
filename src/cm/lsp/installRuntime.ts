function getExecutor(): Executor {
	const executor = (globalThis as unknown as { Executor?: Executor }).Executor;
	if (!executor) {
		throw new Error("Executor plugin is not available");
	}
	return executor;
}

function getBackgroundExecutor(): Executor {
	const executor = getExecutor();
	return executor.BackgroundExecutor ?? executor;
}

export function quoteArg(value: unknown): string {
	const str = String(value ?? "");
	if (!str.length) return "''";
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(str)) return str;
	return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * The bundled Ubuntu rootfs ships an empty /var/lib/apt/lists, so every apt
 * install has to refresh the package lists first. A failed refresh must not
 * abort the install: apt can still succeed from cached lists or cached archives,
 * and the install command itself reports the real failure. debconf front-ends
 * must stay non-interactive because a prompt (tzdata) would block the install.
 */
export function prepareAptCommand(command: string): string {
	return `export DEBIAN_FRONTEND=noninteractive\napt-get update || echo "apt-get update failed; continuing with cached package lists" >&2\n${command}`;
}

/**
 * NodeSource's nodejs package ships npm and declares `Conflicts: npm`, so
 * asking apt for both fails once that repository is configured. Install only
 * nodejs and fall back to Ubuntu's npm package when npm is still missing
 * (the Ubuntu nodejs fallback on architectures NodeSource does not build).
 */
export function buildNpmInstallCommand(options: {
	npmCommand?: string;
	global?: boolean;
	packages: string[];
}): string {
	const npmCommand = options.npmCommand?.trim() || "npm";
	const installFlags = options.global === false ? "install" : "install -g";
	const packages = options.packages.map((entry) => quoteArg(entry)).join(" ");
	const ensureNpm = "command -v npm >/dev/null 2>&1 || apt-get install -y npm";

	return prepareAptCommand(
		`apt-get install -y nodejs && { ${ensureNpm}; } && ${npmCommand} ${installFlags} ${packages}`,
	);
}

export function formatCommand(
	command: string | string[] | null | undefined,
): string {
	if (Array.isArray(command)) {
		return command.map((part) => quoteArg(part)).join(" ");
	}
	if (typeof command === "string") {
		return command.trim();
	}
	return "";
}

function wrapShellCommand(command: string): string {
	const script = command.trim();
	return `sh -lc ${quoteArg(`set -e\n${script}`)}`;
}

export async function runQuickCommand(command: string): Promise<string> {
	const wrapped = wrapShellCommand(command);
	return getBackgroundExecutor().execute(wrapped, true);
}

export async function runForegroundCommand(command: string): Promise<string> {
	const wrapped = wrapShellCommand(command);
	return getExecutor().execute(wrapped, true);
}
