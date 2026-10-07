import fsOperation from "fileSystem";
import loader from "dialogs/loader";
import helpers from "utils/helpers";
import Url from "utils/Url";
import config from "./config";
import { takeStartupLogs } from "./startupLogBuffer";

let erudaInstance = null;
let isInitialized = false;
/** @type {Promise<void> | null} */
let initializing = null;

/**
 * Developer tools module for debugging Acode
 */
const devTools = {
	/**
	 * Check if Eruda is initialized
	 * @returns {boolean}
	 */
	get isInitialized() {
		return isInitialized;
	},

	/**
	 * Get the Eruda instance
	 * @returns {object|null}
	 */
	get eruda() {
		return erudaInstance;
	},

	/**
	 * Initialize Eruda for developer mode
	 * @param {boolean} showLoader - Whether to show a loading dialog
	 * @returns {Promise<void>}
	 */
	init(showLoader = false) {
		if (isInitialized) return Promise.resolve();
		initializing ??= initEruda(showLoader).finally(() => {
			initializing = null;
		});
		return initializing;
	},

	/**
	 * Show the inspector panel
	 */
	async show() {
		await initializing?.catch(() => {});
		if (!isInitialized) {
			window.toast?.("Developer mode is not enabled");
			return;
		}
		const entryBtn =
			erudaInstance?._shadowRoot?.querySelector(".eruda-entry-btn");
		if (entryBtn) entryBtn.style.display = "";
		erudaInstance?.show();
	},

	/**
	 * Hide the inspector panel
	 */
	hide() {
		if (!isInitialized) return;
		erudaInstance?.hide();
		const entryBtn =
			erudaInstance?._shadowRoot?.querySelector(".eruda-entry-btn");
		if (entryBtn) entryBtn.style.display = "none";
	},

	/**
	 * Toggle the inspector panel visibility
	 */
	async toggle() {
		await initializing?.catch(() => {});
		if (!isInitialized) {
			window.toast?.("Developer mode is not enabled");
			return;
		}
		if (erudaInstance?._isShow) {
			this.hide();
		} else {
			this.show();
		}
	},

	/**
	 * Destroy Eruda instance
	 */
	destroy() {
		if (!isInitialized) return;
		erudaInstance?.destroy();
		erudaInstance = null;
		isInitialized = false;
		const script = document.getElementById("eruda-script");
		if (script) script.remove();
	},
};

export default devTools;

/**
 * @param {boolean} showLoader
 */
async function initEruda(showLoader) {
	try {
		const erudaPath = Url.join(DATA_STORAGE, "eruda.js");
		const fs = fsOperation(erudaPath);

		if (!(await fs.exists())) {
			if (showLoader) {
				loader.create(
					strings["downloading file"]?.replace("{file}", "eruda.js") ||
						"Downloading eruda.js...",
					strings["downloading..."] || "Downloading...",
				);
			}

			try {
				const erudaScript = await fsOperation(config.ERUDA_CDN).readFile(
					"utf-8",
				);
				await fsOperation(DATA_STORAGE).createFile("eruda.js", erudaScript);
			} catch {
			} finally {
				if (showLoader) loader.destroy();
			}
		}

		const internalUri = await helpers.toInternalUri(erudaPath);

		await new Promise((resolve, reject) => {
			const script = document.createElement("script");
			script.src = internalUri;
			script.id = "eruda-script";
			script.onload = resolve;
			script.onerror = reject;
			document.head.appendChild(script);
		});

		if (window.eruda) {
			window.eruda.init({
				useShadowDom: true,
				autoScale: true,
				defaults: {
					displaySize: 50,
				},
			});

			window.eruda._shadowRoot.querySelector(".eruda-entry-btn").style.display =
				"none";

			erudaInstance = window.eruda;
			isInitialized = true;
			replayStartupLogs(erudaInstance);
		}
	} catch (error) {
		console.error("Failed to initialize developer tools", error);
		throw error;
	}
}

/**
 * Eruda starts after the editor is visible; show what was logged before it.
 */
function replayStartupLogs(eruda) {
	const erudaConsole = eruda.get?.("console");
	if (!erudaConsole) return;
	for (const { method, args } of takeStartupLogs()) {
		const write = erudaConsole[method] ?? erudaConsole.log;
		write.apply(erudaConsole, args);
	}
}
