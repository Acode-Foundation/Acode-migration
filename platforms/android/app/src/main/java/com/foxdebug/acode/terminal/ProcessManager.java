package com.foxdebug.acode.terminal;

import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import java.io.*;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

public class ProcessManager {

    /**
     * Upper bound for a single command. Without it a child that never closes its
     * pipes (a daemon inheriting stderr) blocks the calling thread forever.
     */
    private static final long COMMAND_TIMEOUT_MINUTES = 15;
    
    private final Context context;
    public static boolean prootDebug = false;
    
    public ProcessManager(Context context) {
        this.context = context;
    }
    
    /**
     * Creates a ProcessBuilder with common environment setup
     */
    public ProcessBuilder createProcessBuilder(String cmd, boolean useUbuntu) {
        if (useUbuntu) {
            refreshAxsSymlink();
        }
        String xcmd = useUbuntu ? "source $PREFIX/init-sandbox.sh " + cmd : cmd;
        ProcessBuilder builder = new ProcessBuilder("sh", "-c", xcmd);
        setupEnvironment(builder.environment());
        return builder;
    }

    /**
     * Play Store builds package axs as a native library. Keep the legacy
     * $PREFIX/axs path valid for scripts and plugins that execute it directly.
     */
    private void refreshAxsSymlink() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || isFdroidBuild()) {
            return;
        }

        Path axsPath = Paths.get(context.getFilesDir().getAbsolutePath(), "axs");
        Path nativeAxsPath = Paths.get(context.getApplicationInfo().nativeLibraryDir, "libaxs.so");

        if (!Files.exists(nativeAxsPath)) {
            return;
        }

        try {
            if (Files.isSymbolicLink(axsPath)) {
                Path currentTarget = Files.readSymbolicLink(axsPath);
                if (currentTarget.equals(nativeAxsPath)) {
                    return;
                }
            }

            Files.deleteIfExists(axsPath);
            Files.createSymbolicLink(axsPath, nativeAxsPath);
        } catch (Exception ignored) {
            // init-sandbox.sh will surface the execution error if the link is unusable.
        }
    }

    private boolean isFdroidBuild() {
        // F-Droid builds are intentionally pinned to targetSdkVersion 28.
        // This convention is also exposed to scripts through the FDROID env var.
        return getTargetSdkVersion() <= 28;
    }

    private int getTargetSdkVersion() {
        try {
            return context.getPackageManager()
                .getPackageInfo(context.getPackageName(), 0)
                .applicationInfo.targetSdkVersion;
        } catch (PackageManager.NameNotFoundException e) {
            return Build.VERSION_CODES.P;
        }
    }
    
    /**
     * Sets up common environment variables
     */
    private void setupEnvironment(Map<String, String> env) {
        env.put("PREFIX", context.getFilesDir().getAbsolutePath());
        env.put("NATIVE_DIR", context.getApplicationInfo().nativeLibraryDir);
        
        TimeZone tz = TimeZone.getDefault();
        env.put("ANDROID_TZ", tz.getID());
        
        env.put("FDROID", String.valueOf(isFdroidBuild()));

        if (prootDebug) {
            env.put("PROOT_VERBOSE", "2");
        }
    }
    
    /**
     * Reads all output from a stream
     */
    public static String readStream(InputStream stream) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(stream));
        StringBuilder output = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) {
            output.append(line).append("\n");
        }
        return output.toString();
    }
    
    /**
     * Executes a command and returns the result
     */
    public ExecResult executeCommand(String cmd, boolean useUbuntu) throws Exception {
        ProcessBuilder builder = createProcessBuilder(cmd, useUbuntu);
        Process process = builder.start();

        // Both pipes must be drained concurrently. Reading stdout to EOF first
        // deadlocks as soon as the child fills the stderr pipe buffer, which
        // apt-get update/install does routinely.
        ExecutorService drainers = Executors.newFixedThreadPool(2);
        long deadline = System.currentTimeMillis() +
            TimeUnit.MINUTES.toMillis(COMMAND_TIMEOUT_MINUTES);
        try {
            Future<String> stdoutFuture = drainers.submit(() -> readStream(process.getInputStream()));
            Future<String> stderrFuture = drainers.submit(() -> readStream(process.getErrorStream()));
            String stdout = stdoutFuture.get(remainingMillis(deadline), TimeUnit.MILLISECONDS);
            String stderr = stderrFuture.get(remainingMillis(deadline), TimeUnit.MILLISECONDS);
            int exitCode = process.waitFor();

            return new ExecResult(exitCode, stdout.trim(), stderr.trim());
        } catch (TimeoutException e) {
            process.destroyForcibly();
            closeQuietly(process.getInputStream());
            closeQuietly(process.getErrorStream());
            throw new IOException(
                "Command timed out after " + COMMAND_TIMEOUT_MINUTES + " minutes: " + cmd,
                e
            );
        } finally {
            drainers.shutdownNow();
        }
    }

    /**
     * Remaining time before the command deadline, never below one millisecond so
     * {@code Future#get} cannot be handed a non-positive timeout.
     */
    private static long remainingMillis(long deadline) {
        return Math.max(1L, deadline - System.currentTimeMillis());
    }

    /**
     * Closing a pipe unblocks a drainer that is still waiting on a grandchild
     * holding the write end after the direct child was killed.
     */
    private static void closeQuietly(InputStream stream) {
        try {
            stream.close();
        } catch (IOException ignored) {
            // Nothing useful to do while reporting the timeout.
        }
    }
    
    /**
     * Result container for command execution
     */
    public static class ExecResult {
        public final int exitCode;
        public final String stdout;
        public final String stderr;
        
        public ExecResult(int exitCode, String stdout, String stderr) {
            this.exitCode = exitCode;
            this.stdout = stdout;
            this.stderr = stderr;
        }
        
        public boolean isSuccess() {
            return exitCode == 0;
        }
        
        public String getErrorMessage() {
            if (!stderr.isEmpty()) {
                return stderr;
            }
            return "Command exited with code: " + exitCode;
        }
    }
}
