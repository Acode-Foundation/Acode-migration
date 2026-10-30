import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const EXTRACTOR_SOURCE = fileURLToPath(
	new URL(
		"../../platforms/android/app/src/main/java/com/foxdebug/acode/system/ArchiveExtractor.java",
		import.meta.url,
	),
);

const JAR_URLS = [
	"https://repo1.maven.org/maven2/org/apache/commons/commons-compress/1.28.0/commons-compress-1.28.0.jar",
	"https://repo1.maven.org/maven2/org/tukaani/xz/1.12/xz-1.12.jar",
	"https://repo1.maven.org/maven2/commons-io/commons-io/2.22.0/commons-io-2.22.0.jar",
	"https://repo1.maven.org/maven2/org/apache/commons/commons-lang3/3.19.0/commons-lang3-3.19.0.jar",
];

const ANDROID_STUBS = {
	"android/system/ErrnoException.java": `package android.system;

public class ErrnoException extends Exception {
  public final int errno;

  public ErrnoException(String functionName, int errno) {
    super(functionName + " failed: errno " + errno);
    this.errno = errno;
  }
}
`,
	"android/system/Os.java": `package android.system;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.attribute.PosixFilePermission;
import java.util.HashSet;
import java.util.Set;

public final class Os {
  private Os() {}

  public static void chmod(String path, int mode) throws ErrnoException {
    Path target = Paths.get(path);
    Set<PosixFilePermission> permissions = new HashSet<>();
    if ((mode & 0400) != 0) permissions.add(PosixFilePermission.OWNER_READ);
    if ((mode & 0200) != 0) permissions.add(PosixFilePermission.OWNER_WRITE);
    if ((mode & 0100) != 0) permissions.add(PosixFilePermission.OWNER_EXECUTE);
    if ((mode & 0040) != 0) permissions.add(PosixFilePermission.GROUP_READ);
    if ((mode & 0020) != 0) permissions.add(PosixFilePermission.GROUP_WRITE);
    if ((mode & 0010) != 0) permissions.add(PosixFilePermission.GROUP_EXECUTE);
    if ((mode & 0004) != 0) permissions.add(PosixFilePermission.OTHERS_READ);
    if ((mode & 0002) != 0) permissions.add(PosixFilePermission.OTHERS_WRITE);
    if ((mode & 0001) != 0) permissions.add(PosixFilePermission.OTHERS_EXECUTE);
    try {
      Files.setPosixFilePermissions(target, permissions);
    } catch (IOException e) {
      ErrnoException failure = new ErrnoException("chmod", 1);
      failure.initCause(e);
      throw failure;
    }
  }
}
`,
	"android/util/Log.java": `package android.util;

public final class Log {
  private Log() {}

  public static int w(String tag, String msg) {
    return 0;
  }

  public static int i(String tag, String msg) {
    return 0;
  }
}
`,
};

const HARNESS_SOURCE = `import com.foxdebug.acode.system.ArchiveExtractor;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.util.Set;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveOutputStream;
import org.apache.commons.compress.compressors.gzip.GzipCompressorOutputStream;

public final class Harness {

  public static void main(String[] args) throws Exception {
    File base = new File(args[0]);
    File absoluteBase = new File(base, "absolute");
    File relativeBase = new File(base, "relative");
    File benignBase = new File(base, "benign");
    File absoluteOutside = new File(absoluteBase, "outside");
    File relativeOutside = new File(relativeBase, "outside");
    File benignDest = new File(benignBase, "dest");
    absoluteOutside.mkdirs();
    relativeOutside.mkdirs();
    benignBase.mkdirs();

    File absoluteArchive = new File(absoluteBase, "malicious-absolute.tar.gz");
    writeTar(
      absoluteArchive,
      Spec.directory("etc/", 0755),
      Spec.symlink("etc/evil", absoluteOutside.getAbsolutePath()),
      Spec.file("etc/evil/pwned.txt", "pwned", 0644)
    );

    File relativeArchive = new File(relativeBase, "malicious-relative.tar.gz");
    writeTar(
      relativeArchive,
      Spec.directory("etc/", 0755),
      Spec.symlink("etc/evil", "../../outside"),
      Spec.file("etc/evil/pwned.txt", "pwned", 0644)
    );

    File benignArchive = new File(benignBase, "benign.tar.gz");
    writeTar(
      benignArchive,
      Spec.directory("bin/", 0755),
      Spec.file("bin/run.sh", "echo hi", 0755),
      Spec.symlink("bin/alias.sh", "run.sh")
    );

    System.out.println(
      "RESULT|malicious-absolute|" +
      extract(absoluteArchive, new File(absoluteBase, "dest"))
    );
    System.out.println(
      "RESULT|malicious-relative|" +
      extract(relativeArchive, new File(relativeBase, "dest"))
    );
    System.out.println("RESULT|benign|" + extract(benignArchive, benignDest));

    File absoluteMarker = new File(absoluteOutside, "pwned.txt");
    File relativeMarker = new File(relativeOutside, "pwned.txt");
    System.out.println(
      "MARKER|absolute|" + absoluteMarker.getAbsolutePath() + "|" + absoluteMarker.exists()
    );
    System.out.println(
      "MARKER|relative|" + relativeMarker.getAbsolutePath() + "|" + relativeMarker.exists()
    );

    Path run = new File(benignDest, "bin/run.sh").toPath();
    Path alias = new File(benignDest, "bin/alias.sh").toPath();
    boolean aliasIsLink = Files.isSymbolicLink(alias);
    System.out.println(
      "RUN|" + run.toAbsolutePath() + "|" + Files.exists(run) + "|" + ownerExecutable(run)
    );
    System.out.println(
      "ALIAS|" + alias.toAbsolutePath() + "|" + aliasIsLink + "|" +
      (aliasIsLink ? Files.readSymbolicLink(alias) : "-") + "|" +
      (aliasIsLink && alias.toRealPath().equals(run.toRealPath()))
    );
  }

  private static String extract(File source, File destination) {
    try {
      ArchiveExtractor.extract(source, destination);
      return "extracted||";
    } catch (IOException e) {
      return "rejected|" + e.getClass().getSimpleName() + "|" + e.getMessage();
    }
  }

  private static boolean ownerExecutable(Path path) throws IOException {
    if (!Files.exists(path)) return false;
    Set<PosixFilePermission> permissions = Files.getPosixFilePermissions(path);
    return permissions.contains(PosixFilePermission.OWNER_EXECUTE);
  }

  private static void writeTar(File output, Spec... specs) throws IOException {
    try (
      OutputStream file = new FileOutputStream(output);
      GzipCompressorOutputStream gzip = new GzipCompressorOutputStream(file);
      TarArchiveOutputStream tar = new TarArchiveOutputStream(gzip)
    ) {
      tar.setLongFileMode(TarArchiveOutputStream.LONGFILE_POSIX);
      tar.setBigNumberMode(TarArchiveOutputStream.BIGNUMBER_POSIX);
      for (Spec spec : specs) {
        TarArchiveEntry entry = new TarArchiveEntry(spec.name, linkFlag(spec));
        entry.setMode(spec.mode);
        if (spec.link != null) {
          entry.setLinkName(spec.link);
          entry.setSize(0);
        } else {
          entry.setSize(spec.data.length);
        }
        tar.putArchiveEntry(entry);
        if (spec.link == null && spec.data.length > 0) {
          tar.write(spec.data);
        }
        tar.closeArchiveEntry();
      }
    }
  }

  private static byte linkFlag(Spec spec) {
    if (spec.link != null) return TarArchiveEntry.LF_SYMLINK;
    if (spec.name.endsWith("/")) return TarArchiveEntry.LF_DIR;
    return TarArchiveEntry.LF_NORMAL;
  }

  private static final class Spec {
    final String name;
    final String link;
    final byte[] data;
    final int mode;

    private Spec(String name, String link, byte[] data, int mode) {
      this.name = name;
      this.link = link;
      this.data = data;
      this.mode = mode;
    }

    static Spec directory(String name, int mode) {
      return new Spec(name, null, new byte[0], mode);
    }

    static Spec file(String name, String content, int mode) {
      return new Spec(name, null, content.getBytes(), mode);
    }

    static Spec symlink(String name, String link) {
      return new Spec(name, link, new byte[0], 0777);
    }
  }

  private Harness() {}
}
`;

const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "acode-archive-extractor-"));
let toolchain = null;
let toolchainError = null;
let harness = null;

/** Raised only when the JDK is missing, the one case that may skip the suite. */
class ToolchainUnavailableError extends Error {}

beforeAll(async () => {
	if (process.env.ACODE_SKIP_ARCHIVE_EXTRACTOR_TEST === "1") {
		toolchainError = new ToolchainUnavailableError(
			"skipped by ACODE_SKIP_ARCHIVE_EXTRACTOR_TEST",
		);
		return;
	}

	try {
		toolchain = await prepareToolchain();
	} catch (error) {
		// Only a missing JDK may skip: a failed download or compile must fail the
		// suite instead of turning the traversal regression test green-by-skip.
		if (error instanceof ToolchainUnavailableError) {
			toolchainError = error;
			return;
		}
		throw error;
	}
	harness = runHarness(toolchain);
}, 300000);

afterAll(() => {
	fs.rmSync(workDirectory, { recursive: true, force: true });
});

describe("ArchiveExtractor", () => {
	it("rejects archives that escape the destination through a symlink", (context) => {
		skipWithoutToolchain(context);
		for (const name of ["malicious-absolute", "malicious-relative"]) {
			const result = harness.results.get(name);
			expect(result, name).toBeDefined();
			expect(result.status, name).toBe("rejected");
			expect(result.exception, name).toBe("ExtractionException");
			expect(result.message, name).toMatch(/escap|traversal/i);
		}
		for (const [name, marker] of harness.markers) {
			expect(marker.exists, name).toBe(false);
			expect(fs.existsSync(marker.path), marker.path).toBe(false);
		}
	});

	it("extracts a benign archive with modes and relative symlinks intact", (context) => {
		skipWithoutToolchain(context);
		expect(harness.results.get("benign").status).toBe("extracted");
		expect(harness.run).toMatchObject({ exists: true, executable: true });
		expect(fs.existsSync(harness.run.path), harness.run.path).toBe(true);
		expect(harness.alias).toMatchObject({
			symlink: true,
			target: "run.sh",
			resolvesToRun: true,
		});
		expect(fs.lstatSync(harness.alias.path).isSymbolicLink()).toBe(true);
	});
});

async function prepareToolchain() {
	if (
		spawnSync("javac", ["-version"]).status !== 0 ||
		spawnSync("java", ["-version"]).status !== 0
	) {
		throw new ToolchainUnavailableError("java/javac are not available");
	}

	const sourceDirectory = path.join(workDirectory, "src");
	const jarsDirectory = path.join(workDirectory, "jars");
	const classesDirectory = path.join(workDirectory, "classes");
	for (const relative of Object.keys(ANDROID_STUBS)) {
		const target = path.join(sourceDirectory, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, ANDROID_STUBS[relative]);
	}
	fs.writeFileSync(path.join(sourceDirectory, "Harness.java"), HARNESS_SOURCE);
	fs.mkdirSync(jarsDirectory, { recursive: true });
	fs.mkdirSync(classesDirectory, { recursive: true });

	const jars = [];
	for (const url of JAR_URLS) {
		const target = path.join(jarsDirectory, path.basename(new URL(url).pathname));
		await download(url, target);
		jars.push(target);
	}

	const extractorClasspath = jars.join(path.delimiter);
	const sources = [
		...Object.keys(ANDROID_STUBS).map((relative) => path.join(sourceDirectory, relative)),
		path.join(sourceDirectory, "Harness.java"),
		EXTRACTOR_SOURCE,
	];
	const compile = spawnSync(
		"javac",
		["-cp", extractorClasspath, "-d", classesDirectory, ...sources],
		{ encoding: "utf8" },
	);
	if (compile.status !== 0) {
		throw new Error(`javac failed: ${compile.stderr || compile.stdout}`);
	}

	const runDirectory = path.join(workDirectory, "run");
	fs.mkdirSync(runDirectory, { recursive: true });
	return {
		classpath: `${classesDirectory}${path.delimiter}${extractorClasspath}`,
		runDirectory,
	};
}

function runHarness({ classpath, runDirectory }) {
	const result = spawnSync("java", ["-cp", classpath, "Harness", runDirectory], {
		encoding: "utf8",
		timeout: 60000,
	});
	if (result.status !== 0) {
		throw new Error(`Harness failed: ${result.stderr || result.stdout}`);
	}
	return parseHarnessOutput(result.stdout);
}

async function download(url, target) {
	const attempts = 3;
	let lastError = null;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
			if (!response.ok) {
				throw new Error(`download of ${url} failed with status ${response.status}`);
			}
			const bytes = Buffer.from(await response.arrayBuffer());
			if (bytes.length === 0) {
				throw new Error(`download of ${url} produced an empty file`);
			}
			fs.writeFileSync(target, bytes);
			return;
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(
		`download of ${url} failed after ${attempts} attempts: ${lastError?.message ?? lastError}`,
	);
}

function parseHarnessOutput(stdout) {
	const results = new Map();
	const markers = new Map();
	let run = null;
	let alias = null;
	for (const line of stdout.split("\n").map((value) => value.trim())) {
		if (line.length === 0) continue;
		const [kind, ...fields] = line.split("|");
		if (kind === "RESULT") {
			results.set(fields[0], {
				status: fields[1] ?? "",
				exception: fields[2] ?? "",
				message: fields[3] ?? "",
			});
		} else if (kind === "MARKER") {
			markers.set(fields[0], { path: fields[1], exists: fields[2] === "true" });
		} else if (kind === "RUN") {
			run = {
				path: fields[0],
				exists: fields[1] === "true",
				executable: fields[2] === "true",
			};
		} else if (kind === "ALIAS") {
			alias = {
				path: fields[0],
				symlink: fields[1] === "true",
				target: fields[2],
				resolvesToRun: fields[3] === "true",
			};
		}
	}
	return { results, markers, run, alias };
}

function skipWithoutToolchain(context) {
	if (toolchainError) {
		context.skip(`archive extractor toolchain unavailable: ${toolchainError.message}`);
	}
}
