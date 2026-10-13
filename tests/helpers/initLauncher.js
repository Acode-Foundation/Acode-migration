import { execFileSync } from "node:child_process";
import fs from "node:fs";

const ASSET_ROOT = "platforms/android/app/src/main/assets";

/**
 * Every shell file the app writes to $PREFIX. init-ubuntu.sh sources the
 * acode-*.sh modules, so the launcher is no longer a single file.
 */
export const SHELL_ASSETS = [
	"init-sandbox.sh",
	"init-ubuntu.sh",
	"acode-log.sh",
	"acode-groups.sh",
	"acode-timezone.sh",
	"acode-node.sh",
	"acode-install.sh",
	"acode-launch.sh",
];

// Slicing shell functions on `^}` alone is wrong: a shell file can embed a
// heredoc whose body contains braces. Track heredoc delimiters and count
// braces only outside them.
const EXTRACTOR = `BEGIN { count = split(ENVIRON["ACODE_WANTED"], wanted, " ") }
function flush(    kept) {
    if (!capturing) return
    kept = (length(block) ? block "\\n" : "") body
    block = kept
    body = ""
    capturing = 0
}
{
    line = $0
    if (capturing) {
        body = (length(body) ? body "\\n" : "") line
        if (delim != "" && line == delim) { delim = ""; next }
        if (delim == "") { depth += gsub(/\\{/, "{") - gsub(/\\}/, "}") }
        if (delim == "" && depth <= 0) { found = 1; flush() }
        next
    }
    if (delim != "") { if (line == delim) delim = ""; next }
    if (match(line, /^[A-Za-z_][A-Za-z0-9_]*\\(\\) \\{$/)) {
        name = substr(line, 1, index(line, "(") - 1)
        wantedHere = 0
        for (i = 1; i <= count; i++) if (wanted[i] == name) wantedHere = 1
        if (!wantedHere) next
        capturing = 1
        body = line
        depth = gsub(/\\{/, "{") - gsub(/\\}/, "}")
        if (match(line, /<<-?'?[A-Za-z_][A-Za-z0-9_]*'?/)) {
            delim = substr(line, RSTART, RLENGTH)
            sub(/^<<-?'?/, "", delim)
            sub(/'?$/, "", delim)
        }
        if (depth <= 0 && delim == "") { found = 1; flush() }
    }
}
END {
    if (!found) exit 1
    printf "%s\\n", block
}`;

export const readAsset = (name) =>
	fs.readFileSync(`${ASSET_ROOT}/${name}`, "utf8");

export const readShellAssets = () => SHELL_ASSETS.map(readAsset).join("\n");

export function readShellFunctions(names, source = readShellAssets()) {
	return execFileSync("awk", [EXTRACTOR], {
		encoding: "utf8",
		env: { ...process.env, ACODE_WANTED: names.join(" ") },
		input: source,
	});
}
