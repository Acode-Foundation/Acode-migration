import type { DirectoryEntry } from "../protocol";
import { baseName, joinPath, parentOf, trimSlash } from "./paths";

export interface FileSystemHost {
	readDirectory(url: string): Promise<DirectoryEntry[]>;
	readFile(url: string): Promise<string>;
}

export interface CrawlOptions {
	skipDirectory(name: string): boolean;
	includeFile(name: string): boolean;
	maxDirectories: number;
	maxFiles: number;
	onProgress?(directories: number, files: number): void;
}

interface DirectoryNode {
	url: string;
	children?: Map<string, DirectoryEntry>;
	loading?: Promise<Map<string, DirectoryEntry> | undefined>;
	failed?: boolean;
}

interface FileNode {
	version: number;
	text?: string;
	loading?: Promise<string | undefined>;
	failed?: boolean;
}

const CONCURRENCY = 4;
const CHANGE_DELAY = 150;

/**
 * Synchronous view of project folders for the TypeScript compiler. Unknown
 * entries read as missing and are fetched from the host in the background;
 * `onChange` fires once they arrive so the program can be rebuilt.
 */
export default class ProjectFileSystem {
	#host: FileSystemHost;
	#onChange: () => void;
	#roots = new Map<string, string>();
	#directories = new Map<string, DirectoryNode>();
	#files = new Map<string, FileNode>();
	#paths = new Map<string, string>();
	#queue: Array<() => Promise<void>> = [];
	#active = 0;
	#version = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;

	constructor(host: FileSystemHost, onChange: () => void) {
		this.#host = host;
		this.#onChange = onChange;
	}

	get version(): number {
		return this.#version;
	}

	get busy(): boolean {
		return this.#active > 0 || this.#queue.length > 0;
	}

	addRoot(path: string, url: string): void {
		this.#roots.set(path, url);
		this.#directories.set(path, { url });
		this.#paths.set(trimSlash(url), path);
	}

	removeRoot(path: string): void {
		this.#roots.delete(path);
		const inside = (key: string) => key === path || key.startsWith(`${path}/`);
		for (const key of this.#directories.keys()) {
			if (inside(key)) this.#directories.delete(key);
		}
		for (const key of this.#files.keys()) {
			if (inside(key)) this.#files.delete(key);
		}
		for (const [url, key] of this.#paths) {
			if (inside(key)) this.#paths.delete(url);
		}
		this.#changed();
	}

	pathOf(url: string): string | undefined {
		return this.#paths.get(trimSlash(url));
	}

	urlOf(path: string): string | undefined {
		const parent = this.#directories.get(parentOf(path));
		return (
			this.#directories.get(path)?.url ??
			parent?.children?.get(baseName(path))?.url
		);
	}

	directoryExists(path: string): boolean {
		const target = trimSlash(path);
		return target === "/" || !!this.#entry(target)?.isDirectory;
	}

	fileExists(path: string): boolean {
		const entry = this.#entry(path);
		return !!entry && !entry.isDirectory;
	}

	readFile(path: string): string | undefined {
		const node = this.#files.get(path);
		if (node?.text !== undefined || node?.loading || node?.failed) {
			return node.text;
		}
		const entry = this.#entry(path);
		if (entry && !entry.isDirectory) void this.#loadFile(path, entry.url);
		return undefined;
	}

	fileVersion(path: string): number {
		return this.#files.get(path)?.version ?? 0;
	}

	getEntries(path: string): { files: string[]; directories: string[] } {
		const files: string[] = [];
		const directories: string[] = [];
		for (const entry of this.#children(trimSlash(path))?.values() ?? []) {
			(entry.isDirectory ? directories : files).push(entry.name);
		}
		return { files, directories };
	}

	/** Drop cached content so the next read comes from the host again. */
	invalidate(path: string): void {
		if (this.#files.delete(path)) this.#changed();
	}

	async list(path: string): Promise<Map<string, DirectoryEntry> | undefined> {
		const node = this.#directory(path);
		if (!node || node.failed) return undefined;
		return node.children ?? this.#loadDirectory(path, node);
	}

	async read(path: string): Promise<string | undefined> {
		const entry = (await this.list(parentOf(path)))?.get(baseName(path));
		if (!entry || entry.isDirectory) return undefined;
		const node = this.#files.get(path);
		if (node?.text !== undefined) return node.text;
		return node?.loading ?? this.#loadFile(path, entry.url);
	}

	async crawl(root: string, options: CrawlOptions): Promise<string[]> {
		const files: string[] = [];
		let level = [root];
		let visited = 0;
		while (level.length && visited < options.maxDirectories) {
			const batch = level.slice(0, options.maxDirectories - visited);
			visited += batch.length;
			const listings = await Promise.all(batch.map((dir) => this.list(dir)));
			level = [];
			batch.forEach((dir, index) => {
				for (const entry of listings[index]?.values() ?? []) {
					const child = joinPath(dir, entry.name);
					if (entry.isDirectory) {
						if (!options.skipDirectory(entry.name)) level.push(child);
					} else if (
						files.length < options.maxFiles &&
						options.includeFile(entry.name)
					) {
						files.push(child);
					}
				}
			});
			options.onProgress?.(visited, files.length);
		}
		return files;
	}

	#entry(path: string): DirectoryEntry | undefined {
		return this.#children(parentOf(path))?.get(baseName(path));
	}

	#children(path: string): Map<string, DirectoryEntry> | undefined {
		if (path === "/") return this.#rootEntries();
		const node = this.#directory(path);
		if (!node || node.failed) return undefined;
		if (!node.children && !node.loading) void this.#loadDirectory(path, node);
		return node.children;
	}

	#directory(path: string): DirectoryNode | undefined {
		const known = this.#directories.get(path);
		if (known || path === "/") return known;
		const entry = this.#entry(path);
		if (!entry?.isDirectory) return undefined;
		const node: DirectoryNode = { url: entry.url };
		this.#directories.set(path, node);
		return node;
	}

	#rootEntries(): Map<string, DirectoryEntry> {
		const entries = new Map<string, DirectoryEntry>();
		for (const [path, url] of this.#roots) {
			const name = baseName(path);
			entries.set(name, { name, url, isDirectory: true });
		}
		return entries;
	}

	#loadDirectory(
		path: string,
		node: DirectoryNode,
	): Promise<Map<string, DirectoryEntry> | undefined> {
		node.loading = this.#enqueue(async () => {
			try {
				const children = new Map<string, DirectoryEntry>();
				for (const entry of await this.#host.readDirectory(node.url)) {
					children.set(entry.name, entry);
					this.#paths.set(trimSlash(entry.url), joinPath(path, entry.name));
				}
				node.children = children;
			} catch {
				node.failed = true;
			}
			node.loading = undefined;
			this.#changed();
			return node.children;
		});
		return node.loading;
	}

	#loadFile(path: string, url: string): Promise<string | undefined> {
		const node: FileNode = this.#files.get(path) ?? { version: 0 };
		this.#files.set(path, node);
		node.loading = this.#enqueue(async () => {
			try {
				node.text = await this.#host.readFile(url);
				node.version++;
			} catch {
				node.failed = true;
			}
			node.loading = undefined;
			this.#changed();
			return node.text;
		});
		return node.loading;
	}

	#enqueue<T>(task: () => Promise<T>): Promise<T> {
		return new Promise((resolve, reject) => {
			this.#queue.push(() => task().then(resolve, reject));
			this.#drain();
		});
	}

	#drain(): void {
		while (this.#active < CONCURRENCY && this.#queue.length) {
			const job = this.#queue.shift()!;
			this.#active++;
			void job().finally(() => {
				this.#active--;
				this.#drain();
			});
		}
	}

	#changed(): void {
		this.#version++;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#onChange();
		}, CHANGE_DELAY);
	}
}
