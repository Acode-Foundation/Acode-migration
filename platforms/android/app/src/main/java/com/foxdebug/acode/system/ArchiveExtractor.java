package com.foxdebug.acode.system;

import android.system.ErrnoException;
import android.system.Os;
import android.util.Log;
import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.SequenceInputStream;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.apache.commons.compress.compressors.CompressorException;
import org.apache.commons.compress.compressors.CompressorStreamFactory;
import org.apache.commons.compress.compressors.gzip.GzipCompressorInputStream;

/**
 * Extracts tar archives that may be gzip, xz, bzip2 or uncompressed. Every
 * entry is validated against the destination before anything touches the
 * filesystem, so a malicious archive cannot escape through traversal names or
 * through a symlink planted by an earlier entry.
 */
public final class ArchiveExtractor {

  private static final String TAG = "ArchiveExtractor";

  /** Backstops against decompression bombs. */
  private static final long MAX_TOTAL_BYTES = 8L * 1024 * 1024 * 1024;
  private static final int MAX_ENTRIES = 500_000;
  private static final int BUFFER_SIZE = 8192;

  /** Modes applied when the archive's own mode cannot be set on the volume. */
  private static final int FALLBACK_DIRECTORY_MODE = 0755;
  private static final int FALLBACK_FILE_MODE = 0644;
  private static final int FALLBACK_EXECUTABLE_MODE = 0755;

  private static final char MODE_EXECUTABLE = 0111;

  private static final int[] XZ_MAGIC = { 0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00 };
  private static final int[] BZIP2_MAGIC = { 0x42, 0x5A, 0x68 };
  private static final int[] ZSTD_MAGIC = { 0x28, 0xB5, 0x2F, 0xFD };

  public static final class ExtractionException extends IOException {
    private static final long serialVersionUID = 1L;

    ExtractionException(String message) {
      super(message);
    }
  }

  private ArchiveExtractor() {}

  public static void extract(File source, File destination) throws IOException {
    File destDir = ensureDirectory(destination);
    String canonicalDest = destDir.getCanonicalPath();
    Map<File, Integer> directoryModes = new LinkedHashMap<>();
    List<String> problems = new ArrayList<>(0);

    try (
      InputStream compIn = openDecompressedStream(source);
      TarArchiveInputStream tarIn = new TarArchiveInputStream(compIn)
    ) {
      TarArchiveEntry entry;
      long totalBytes = 0;
      int entryCount = 0;

      while ((entry = tarIn.getNextEntry()) != null) {
        if (++entryCount > MAX_ENTRIES) {
          throw new ExtractionException(
            "Archive contains more than " + MAX_ENTRIES + " entries"
          );
        }

        totalBytes += Math.max(entry.getSize(), 0);
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new ExtractionException(
            "Archive expands beyond " + MAX_TOTAL_BYTES + " bytes"
          );
        }

        String name = entry.getName();
        if (name == null || name.isEmpty()) continue;

        String linkName = entry.getLinkName();
        boolean hasLinkTarget = linkName != null && !linkName.isEmpty();
        File entryFile = resolveEntry(destDir, canonicalDest, name);

        if (entry.isDirectory()) {
          ensureDirectory(entryFile);
          directoryModes.put(entryFile, entry.getMode());
          continue;
        }

        ensureParentDirectory(entryFile);

        if (entry.isSymbolicLink() && hasLinkTarget) {
          createSymbolicLink(canonicalDest, entryFile, linkName, problems);
        } else if (entry.isLink() && hasLinkTarget) {
          if (!recreateHardLink(canonicalDest, entryFile, linkName)) {
            problems.add(
              "hard link without a usable target: " + name + " -> " + linkName
            );
          }
        } else if (entry.isFile()) {
          long written = writeFile(tarIn, entryFile);
          if (entry.getSize() > 0 && written != entry.getSize()) {
            problems.add(
              "truncated entry " + name + ": expected " +
              entry.getSize() + " bytes, wrote " + written
            );
          }
          applyMode(entryFile, entry.getMode(), problems);
        } else {
          // Character/block devices, FIFOs and sockets cannot exist in app
          // private storage; skipping keeps the rest of the archive usable.
          problems.add("unsupported entry type skipped: " + name);
        }
      }
    }

    // Directory modes land last so a read-only directory never blocks the
    // entries written into it.
    for (Map.Entry<File, Integer> directory : directoryModes.entrySet()) {
      applyMode(directory.getKey(), directory.getValue(), problems);
    }

    reportProblems(problems);
  }

  /**
   * Opens the archive, transparently decompressing gzip, xz, bzip2 and zstd
   * (when the optional zstd-jni codec is on the classpath).
   * {@code TarArchiveInputStream} does not auto-detect compression, so the
   * format is sniffed from the leading magic bytes and only the bytes that were
   * actually read are handed on, which keeps a mis-detection from losing data.
   */
  private static InputStream openDecompressedStream(File source)
    throws IOException {
    BufferedInputStream buffered = new BufferedInputStream(
      new FileInputStream(source)
    );
    try {
      byte[] header = readHeader(buffered);
      if (header.length >= 2 && (header[0] & 0xFF) == 0x1F && (header[1] & 0xFF) == 0x8B) {
        return GzipCompressorInputStream.builder()
          .setInputStream(replay(header, buffered))
          .setDecompressConcatenated(true)
          .get();
      }

      String compressor = compressorFor(header);
      if (compressor != null) {
        try {
          return new CompressorStreamFactory()
            .createCompressorInputStream(compressor, replay(header, buffered));
        } catch (CompressorException e) {
          // Reported instead of falling back to raw tar: the magic bytes are
          // unambiguous, so a missing codec (zstd-jni) must not be misread as an
          // uncompressed archive.
          throw new ExtractionException(
            "No codec available for " + compressor + " archive: " + e.getMessage()
          );
        }
      }

      // Uncompressed tar: no compressor signature to detect.
      return replay(header, buffered);
    } catch (IOException e) {
      try {
        buffered.close();
      } catch (IOException ignored) {
        // Reporting the original failure is more useful than the close error.
      }
      throw e;
    }
  }

  private static byte[] readHeader(InputStream in) throws IOException {
    byte[] header = new byte[6];
    int filled = 0;
    while (filled < header.length) {
      int read = in.read(header, filled, header.length - filled);
      if (read == -1) break;
      filled += read;
    }
    if (filled == header.length) return header;
    byte[] shortHeader = new byte[filled];
    java.lang.System.arraycopy(header, 0, shortHeader, 0, filled);
    return shortHeader;
  }

  private static String compressorFor(byte[] header) {
    if (header.length >= 6 && startsWith(header, XZ_MAGIC)) {
      return CompressorStreamFactory.XZ;
    }
    if (header.length >= 3 && startsWith(header, BZIP2_MAGIC)) {
      return CompressorStreamFactory.BZIP2;
    }
    if (header.length >= 4 && startsWith(header, ZSTD_MAGIC)) {
      return CompressorStreamFactory.ZSTANDARD;
    }
    return null;
  }

  private static boolean startsWith(byte[] header, int[] magic) {
    if (header.length < magic.length) return false;
    for (int index = 0; index < magic.length; index++) {
      if ((header[index] & 0xFF) != magic[index]) return false;
    }
    return true;
  }

  /**
   * Re-attaches the sniffed bytes in front of the underlying stream without
   * relying on {@code mark}/{@code reset} support in the wrapped stream.
   */
  private static InputStream replay(byte[] header, InputStream rest) {
    if (header.length == 0) return rest;
    return new SequenceInputStream(new ByteArrayInputStream(header), rest);
  }

  /**
   * Resolves a tar entry name inside the destination and rejects anything that
   * escapes it. Absolute names are rejected outright: tar entries are defined
   * relative to the archive root, and on Windows {@code new File(parent, child)}
   * would silently discard {@code parent} for an absolute child.
   */
  private static File resolveEntry(
    File destDir,
    String canonicalDest,
    String name
  ) throws IOException {
    if (name.startsWith("/") || name.matches("^[A-Za-z]:[\\\\/].*")) {
      throw new ExtractionException("Absolute path in tar entry: " + name);
    }

    File candidate = new File(destDir, name);
    if (!isContained(canonicalDest, candidate)) {
      throw new ExtractionException("Path traversal detected in tar entry: " + name);
    }
    return candidate;
  }

  /**
   * Creates a symlink after rejecting a target that resolves outside the
   * destination. The link target is interpreted relative to the link's own
   * directory, matching the kernel, so {@code ../../etc/passwd} is caught even
   * though the link name itself is harmless.
   *
   * <p>Failures that are not security relevant (the host volume refusing
   * symlinks, a conflicting non-empty directory) are recorded as problems rather
   * than aborting, so the rest of the archive stays usable.
   */
  private static void createSymbolicLink(
    String canonicalDest,
    File linkFile,
    String linkName,
    List<String> problems
  ) throws IOException {
    File resolved = new File(linkFile.getParentFile(), linkName).getCanonicalFile();
    if (!isContained(canonicalDest, resolved)) {
      throw new ExtractionException(
        "Refusing symlink escaping the archive root: " +
        linkFile.getName() + " -> " + linkName
      );
    }

    try {
      Files.deleteIfExists(linkFile.toPath());
      Files.createSymbolicLink(linkFile.toPath(), Paths.get(linkName));
    } catch (UnsupportedOperationException | IOException e) {
      // PRoot's --link2symlink makes symlinks usable inside the guest, but the
      // host volume may still refuse them.
      problems.add(
        "cannot create symlink " +
        linkFile.getPath() + " -> " + linkName + ": " + e.getMessage()
      );
    }
  }

  /**
   * Recreates a tar hard link as an independent copy. Hard-link entries carry no
   * payload and their names are relative to the archive root, not to the link's
   * own directory. App private storage does not reliably support link(2), so the
   * already extracted target is copied instead.
   */
  private static boolean recreateHardLink(
    String canonicalDest,
    File linkFile,
    String linkName
  ) {
    try {
      File target = new File(canonicalDest, linkName.replaceFirst("^/+", ""));
      if (
        !isContained(canonicalDest, target) ||
        !target.exists() ||
        target.isDirectory()
      ) {
        return false;
      }

      ensureParentDirectory(linkFile);
      Files.copy(
        target.toPath(),
        linkFile.toPath(),
        StandardCopyOption.REPLACE_EXISTING
      );
      return true;
    } catch (IOException e) {
      Log.w(
        TAG,
        "Can't recreate hard link " + linkFile.getPath() + " -> " + linkName
      );
      return false;
    }
  }

  private static long writeFile(TarArchiveInputStream tarIn, File entryFile)
    throws IOException {
    long written = 0;
    try (OutputStream out = new FileOutputStream(entryFile)) {
      byte[] buffer = new byte[BUFFER_SIZE];
      int length;
      while ((length = tarIn.read(buffer)) != -1) {
        out.write(buffer, 0, length);
        written += length;
      }
      out.flush();
    }
    return written;
  }

  private static File ensureDirectory(File directory) throws IOException {
    if (directory.isDirectory()) return directory;
    if (!directory.mkdirs() && !directory.isDirectory()) {
      throw new ExtractionException("Cannot create directory: " + directory);
    }
    return directory;
  }

  private static void ensureParentDirectory(File file) throws IOException {
    File parent = file.getParentFile();
    if (parent != null) {
      ensureDirectory(parent);
    }
  }

  /**
   * Containment check on the fully resolved path. {@link File#getCanonicalPath()}
   * follows every symlink in the entry's ancestry, so an entry written through a
   * symlinked directory is accepted only when the symlink itself resolves inside
   * the destination. Archives that legitimately place files under a symlinked
   * directory (for example a rootfs that links {@code /var/run -> /run}) must not
   * be rejected, so no separate parent-symlink rule is applied.
   */
  private static boolean isContained(String canonicalDest, File candidate)
    throws IOException {
    String canonical = candidate.getCanonicalPath();
    return (
      canonical.equals(canonicalDest) ||
      canonical.startsWith(canonicalDest + File.separator)
    );
  }

  /**
   * Applies the archive's mode, falling back to a sane default when the volume
   * refuses the change. Failures are collected instead of swallowed so a
   * non-executable rootfs surfaces as a warning rather than a mystery
   * "Permission denied" at first launch.
   */
  private static void applyMode(File file, int mode, List<String> problems) {
    int permissions = mode & 07777;
    if (permissions == 0) {
      permissions = file.isDirectory() ? FALLBACK_DIRECTORY_MODE : FALLBACK_FILE_MODE;
    }

    try {
      Os.chmod(file.getAbsolutePath(), permissions);
      return;
    } catch (ErrnoException e) {
      // Fall through to java.io, which routes through a different syscall path.
    }

    boolean applied;
    if (file.isDirectory()) {
      applied = file.setReadable(true, false) & file.setExecutable(true, false);
    } else {
      applied = applyFileFallback(file, permissions);
    }

    if (!applied) {
      problems.add(
        "cannot set mode " +
        Integer.toOctalString(permissions) +
        " on " +
        file.getPath()
      );
    }
  }

  private static boolean applyFileFallback(File file, int permissions) {
    boolean executable = (permissions & MODE_EXECUTABLE) != 0;
    boolean readable = file.setReadable(true, false);
    if (!executable) return readable;
    return readable & file.setExecutable(true, false);
  }

  private static void reportProblems(List<String> problems) {
    if (problems.isEmpty()) return;
    Log.w(
      TAG,
      "Extraction finished with " +
      problems.size() +
      " problem(s); first: " +
      problems.get(0)
    );
  }
}
