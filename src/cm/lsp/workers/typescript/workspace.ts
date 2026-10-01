import ts from "typescript";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { WorkDoneProgress } from "../progress";
import DocumentHost from "./documentHost";
import ProjectFileSystem, { type FileSystemHost } from "./fileSystem";
import { trimSlash } from "./paths";
import Project from "./project";

/** Everything a language feature needs to query TypeScript for one document. */
export interface ServiceTarget {
	service: ts.LanguageService;
	document: TextDocument;
	fileName: string;
	checkJs: boolean;
	uriOf(fileName: string): string | undefined;
	documentOf(fileName: string): TextDocument | undefined;
}

// Crawling a remote tree would flood the connection; those files stay in
// single-file mode.
const REMOTE_FOLDER = /^s?ftps?:/i;

interface WorkspaceOptions {
	documents: Map<string, TextDocument>;
	documentsVersion(): string;
	libraries: Record<string, string>;
	host: FileSystemHost;
	onChange(): void;
	log(message: string): void;
	progress(title: string, message?: string): WorkDoneProgress;
}

export default class TypeScriptWorkspace {
	#options: WorkspaceOptions;
	#fs: ProjectFileSystem;
	#projects = new Map<string, Project>();
	#registry = ts.createDocumentRegistry(true, "/");
	#fallback: ts.LanguageService;
	#nextRoot = 0;

	constructor(options: WorkspaceOptions) {
		this.#options = options;
		this.#fs = new ProjectFileSystem(options.host, () => this.#changed());
		const host = new DocumentHost(
			options.documents,
			options.libraries,
			(uri) => !!this.#projectFor(uri),
			() => `${options.documentsVersion()}:${this.#fs.version}`,
		);
		this.#fallback = ts.createLanguageService(host, this.#registry);
	}

	addFolder(url: string): void {
		const key = trimSlash(url);
		if (!key || REMOTE_FOLDER.test(key) || this.#projects.has(key)) return;
		const root = `/ws${this.#nextRoot++}`;
		this.#fs.addRoot(root, key);
		const project = new Project({
			fs: this.#fs,
			root,
			documents: this.#options.documents,
			documentsVersion: this.#options.documentsVersion,
			libraries: this.#options.libraries,
			registry: this.#registry,
		});
		this.#projects.set(key, project);
		// Started lazily so a single file passed as the root never flashes one.
		let progress: WorkDoneProgress | undefined;
		const report = (message: string) => {
			if (progress) progress.report(message);
			else
				progress = this.#options.progress(
					`Loading ${folderName(key)}`,
					message,
				);
		};
		project.load(report).then(
			(loaded) => {
				progress?.end();
				if (!loaded) {
					this.removeFolder(key);
					return;
				}
				this.#options.log(`Project-wide analysis enabled for ${key}`);
				this.#options.onChange();
			},
			(error) => {
				progress?.end();
				this.#options.log(`Project load failed for ${key}: ${error}`);
				this.removeFolder(key);
			},
		);
	}

	removeFolder(url: string): void {
		const key = trimSlash(url);
		const project = this.#projects.get(key);
		if (!project) return;
		this.#projects.delete(key);
		this.#fs.removeRoot(project.root);
		project.dispose();
		this.#options.onChange();
	}

	target(document: TextDocument): ServiceTarget {
		const project = this.#projectFor(document.uri);
		const fileName = project?.pathOf(document.uri);
		if (project && fileName) {
			return {
				service: project.service,
				document,
				fileName,
				checkJs: project.checksJavaScript,
				uriOf: (name) => project.uriOf(name),
				documentOf: (name) => project.documentOf(name),
			};
		}
		const { documents } = this.#options;
		return {
			service: this.#fallback,
			document,
			fileName: document.uri,
			checkJs: false,
			uriOf: (name) => (documents.has(name) ? name : undefined),
			documentOf: (name) => documents.get(name),
		};
	}

	/** A closed tab may hold unsaved text; reread the file from disk next time. */
	documentClosed(uri: string): void {
		const path = this.#fs.pathOf(uri);
		if (path) this.#fs.invalidate(path);
		// Releasing the semantic cache forces open tabs to be re-analysed, so
		// only do it once the single-file service has nothing left to serve.
		if (this.#options.documents.size === 0)
			this.#fallback.cleanupSemanticCache();
	}

	dispose(): void {
		for (const project of this.#projects.values()) project.dispose();
		this.#projects.clear();
		this.#fallback.dispose();
	}

	#projectFor(uri: string): Project | undefined {
		for (const project of this.#projects.values()) {
			if (project.pathOf(uri)) return project;
		}
		return undefined;
	}

	#changed(): void {
		// Keep rebuilding until fetches stop arriving; each completion
		// schedules another change notification.
		if (this.#fs.busy) return;
		for (const project of this.#projects.values()) {
			if (project.loaded) project.refresh();
		}
		this.#options.onChange();
	}
}

function folderName(url: string): string {
	return decodeURIComponent(url.slice(url.lastIndexOf("/") + 1)) || url;
}
