import { describe, expect, it } from "vitest";
import { buildNpmInstallCommand } from "cm/lsp/installRuntime";

describe("buildNpmInstallCommand", () => {
	it("does not install Ubuntu's npm next to NodeSource's nodejs", () => {
		const command = buildNpmInstallCommand({
			packages: ["@typescript/native@npm:typescript@^7.0.2"],
		});

		// NodeSource's nodejs Provides npm and Conflicts: npm, so asking apt for
		// both fails the install for every npm-based server.
		expect(command).not.toContain("install -y nodejs npm");
		expect(command).toContain("apt-get install -y nodejs");
		expect(command).toContain(
			"command -v npm >/dev/null 2>&1 || apt-get install -y npm",
		);
	});

	it("installs the requested packages globally by default", () => {
		const command = buildNpmInstallCommand({
			packages: ["typescript-language-server"],
		});

		expect(command).toContain("npm install -g typescript-language-server");
	});

	it("honors a non-global install and a custom npm command", () => {
		const command = buildNpmInstallCommand({
			npmCommand: "npm --prefix /opt/lsp",
			global: false,
			packages: ["tailwindcss-language-server"],
		});

		expect(command).toContain(
			"npm --prefix /opt/lsp install tailwindcss-language-server",
		);
	});

	it("refreshes the apt lists before installing", () => {
		expect(buildNpmInstallCommand({ packages: ["x"] })).toContain(
			"apt-get update",
		);
	});
});
