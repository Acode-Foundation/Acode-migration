import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { diagnostics } from "../../src/cm/lsp/workers/typescript/features";
import {
	definitions,
	implementations,
	references,
	typeDefinitions,
} from "../../src/cm/lsp/workers/typescript/navigation";
import TypeScriptWorkspace from "../../src/cm/lsp/workers/typescript/workspace";

const libDirectory = path.dirname(
	require.resolve("typescript/lib/lib.es5.d.ts"),
);
const libraries = Object.fromEntries(
	fs
		.readdirSync(libDirectory)
		.filter((name) => /^lib\..+\.d\.ts$/.test(name))
		.map((name) => [
			name,
			fs.readFileSync(path.join(libDirectory, name), "utf8"),
		]),
);

const projectFiles = {
	"file:///p/tsconfig.json": JSON.stringify({
		compilerOptions: {
			strict: true,
			target: "es2022",
			moduleResolution: "bundler",
			module: "esnext",
		},
		include: ["src"],
	}),
	"file:///p/src/main.ts": [
		'import { greet } from "./greet";',
		'import { pad } from "padder";',
		'const total: number = greet("x");',
		"export const padded = pad(1);",
	].join("\n"),
	"file:///p/src/greet.ts":
		"export function greet(name: string): string {\n\treturn name;\n}\n",
	"file:///p/src/other.ts":
		'import { greet } from "./greet";\nexport const other = greet("y");\n',
	"file:///p/src/shape.ts": "export interface Shape {\n\tarea(): number;\n}\n",
	"file:///p/src/circle.ts":
		'import type { Shape } from "./shape";\nexport class Circle implements Shape {\n\tarea() {\n\t\treturn 1;\n\t}\n}\n',
	"file:///p/src/use.ts":
		'import type { Shape } from "./shape";\nexport function size(shape: Shape) {\n\treturn shape.area();\n}\n',
	"file:///p/scripts/tool.ts":
		'import { greet } from "../src/greet";\ngreet("z");\n',
	"file:///p/node_modules/padder/package.json": JSON.stringify({
		name: "padder",
		types: "index.d.ts",
	}),
	"file:///p/node_modules/padder/index.d.ts":
		"export declare function pad(value: number): string;\n",
};

describe("TypeScript worker project mode", () => {
	it("resolves unopened project files and node_modules types", async () => {
		const { workspace, open, settle, progress } = createWorkspace(projectFiles);
		workspace.addFolder("file:///p");
		const main = open("file:///p/src/main.ts");

		const found = await settle(() => diagnostics(workspace.target(main)));
		const errors = found.filter((item) => item.severity === 1);

		expect(errors.map((item) => item.code)).toEqual([2322]);
		expect(progress[0]).toBe("begin Loading p");
		expect(progress.at(-1)).toBe("end");
		expect(errors[0].range.start).toEqual({ line: 2, character: 6 });
	});

	it("navigates into unopened files and honours tsconfig include", async () => {
		const { workspace, open, settle } = createWorkspace(projectFiles);
		workspace.addFolder("file:///p");
		const main = open("file:///p/src/main.ts");
		const offset = main.getText().indexOf("greet(");

		const links = await settle(() =>
			definitions(workspace.target(main), offset),
		);
		expect(links).toHaveLength(1);
		expect(links[0].targetUri).toBe("file:///p/src/greet.ts");
		expect(links[0].targetSelectionRange.start).toEqual({
			line: 0,
			character: 16,
		});

		const uris = references(workspace.target(main), offset).map(
			(item) => item.uri,
		);
		expect(uris).toContain("file:///p/src/other.ts");
		expect(uris).not.toContain("file:///p/scripts/tool.ts");
	});

	it("finds implementations and type definitions in unopened files", async () => {
		const { workspace, open, settle } = createWorkspace(projectFiles);
		workspace.addFolder("file:///p");
		const use = open("file:///p/src/use.ts");
		const text = use.getText();

		const found = await settle(() =>
			implementations(workspace.target(use), text.indexOf("area()")),
		);
		expect(found.map((item) => [item.uri, item.range.start.line])).toEqual([
			["file:///p/src/circle.ts", 2],
		]);

		const types = typeDefinitions(
			workspace.target(use),
			text.indexOf("shape.area"),
		);
		expect(types.map((item) => [item.uri, item.range.start.line])).toEqual([
			["file:///p/src/shape.ts", 0],
		]);
	});

	it("infers a project from source files when there is no tsconfig", async () => {
		const { workspace, open, settle } = createWorkspace({
			"file:///q/app.js":
				'import { helper } from "./lib/helper.js";\nhelper();\n',
			"file:///q/lib/helper.js": "export function helper() {}\n",
		});
		workspace.addFolder("file:///q/");
		const app = open("file:///q/app.js", "javascript");
		const offset = app.getText().lastIndexOf("helper");

		const links = await settle(() =>
			definitions(workspace.target(app), offset),
		);
		expect(links.map((link) => link.targetUri)).toEqual([
			"file:///q/lib/helper.js",
		]);
	});

	it("keeps single-file analysis for documents outside any folder", async () => {
		const { workspace, open, settle, progress } = createWorkspace(projectFiles);
		workspace.addFolder("file:///p/src/main.ts");
		const loose = open(
			"untitled:scratch.ts",
			"typescript",
			'const value: number = "text";',
		);

		const found = await settle(() => diagnostics(workspace.target(loose)));
		const errors = found.filter((item) => item.severity === 1);

		expect(errors.map((item) => item.code)).toEqual([2322]);
		expect(workspace.target(loose).fileName).toBe("untitled:scratch.ts");
		expect(progress).toEqual([]);
	});
});

function createWorkspace(files: Record<string, string>) {
	const documents = new Map<string, TextDocument>();
	let version = 0;
	let changes = 0;
	const progress: string[] = [];
	const workspace = new TypeScriptWorkspace({
		documents,
		documentsVersion: () => String(version),
		libraries,
		host: memoryHost(files),
		onChange: () => changes++,
		log: () => {},
		progress: (title) => {
			progress.push(`begin ${title}`);
			return {
				report: () => progress.push("report"),
				end: () => progress.push("end"),
			};
		},
	});
	const open = (uri: string, languageId = "typescript", text = files[uri]) => {
		const document = TextDocument.create(uri, languageId, 1, text ?? "");
		documents.set(uri, document);
		version++;
		return document;
	};
	/** Repeat a query until background file loading stops producing changes. */
	const settle = async <T>(query: () => T): Promise<T> => {
		for (let attempt = 0; attempt < 40; attempt++) {
			const before = changes;
			const result = query();
			await new Promise((resolve) => setTimeout(resolve, 400));
			if (changes === before) return result;
		}
		throw new Error("TypeScript project did not settle");
	};
	return { workspace, open, settle, progress };
}

function memoryHost(files: Record<string, string>) {
	return {
		async readDirectory(url: string) {
			const prefix = url.endsWith("/") ? url : `${url}/`;
			const entries = new Map<
				string,
				{ name: string; url: string; isDirectory: boolean }
			>();
			for (const file of Object.keys(files)) {
				if (!file.startsWith(prefix)) continue;
				const [name, ...rest] = file.slice(prefix.length).split("/");
				entries.set(name, {
					name,
					url: prefix + name,
					isDirectory: rest.length > 0,
				});
			}
			if (!entries.size) throw new Error(`${url} is not a directory`);
			return [...entries.values()];
		},
		async readFile(url: string) {
			if (!(url in files)) throw new Error(`${url} does not exist`);
			return files[url];
		},
	};
}
