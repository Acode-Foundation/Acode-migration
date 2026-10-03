import type { DirectoryEntry } from "../protocol";
import { joinPath } from "./paths";

export interface CrawlOptions {
	skipDirectory(name: string): boolean;
	includeFile(name: string): boolean;
	maxDirectories: number;
	maxFiles: number;
	onProgress?(directories: number, files: number): void;
}

interface Listing {
	list(path: string): Promise<Map<string, DirectoryEntry> | undefined>;
}

/** Breadth-first scan for source files, bounded by the directory budget. */
export default async function crawl(
	fs: Listing,
	root: string,
	options: CrawlOptions,
): Promise<string[]> {
	const files: string[] = [];
	let level = [root];
	let visited = 0;
	while (level.length && visited < options.maxDirectories) {
		const batch = level.slice(0, options.maxDirectories - visited);
		visited += batch.length;
		const listings = await Promise.all(batch.map((dir) => fs.list(dir)));
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
