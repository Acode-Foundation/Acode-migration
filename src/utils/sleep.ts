/**
 * Promise-based delay shared by the terminal lifecycle and runtime helpers.
 */
export default function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
