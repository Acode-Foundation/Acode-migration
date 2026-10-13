import AcodeUbuntu
import Foundation

enum UbuntuMaintenance {
    static func perform(_ action: String, callback: Callback) throws {
        let runtime = UbuntuRuntime.shared
        let backup = runtime.files.data.appendingPathComponent("aterm_backup.tar")
        switch action {
        case "clearBackup":
            if FileManager.default.fileExists(atPath: backup.path) { try FileManager.default.removeItem(at: backup) }
            callback.success()
        case "backup":
            guard runtime.installed else { throw terminalError("Ubuntu is not installed.") }
            try runtime.start("""
                tar -cf /acode/aterm_backup.tar -C / \
                  --exclude=./acode --exclude=./acode-assets --exclude=./public \
                  --exclude=./home --exclude=./root --exclude=./dev --exclude=./proc \
                  --exclude=./sys --exclude=./run --exclude=./tmp \
                  --exclude=./Users --exclude=./private --exclude=./var/mobile .
                """, completion: { status, _, errors in
                    if status == 0 { callback.success(backup.absoluteString) }
                    else { callback.error(errors) }
                })
        case "restore":
            guard FileManager.default.fileExists(atPath: backup.path) else { throw terminalError("Backup File does not exist") }
            let staging = runtime.root.appendingPathExtension("restore")
            try? FileManager.default.removeItem(at: staging)
            var error = [CChar](repeating: 0, count: 1024)
            guard ubuntu_import(backup.path, staging.path, &error, error.count) else {
                try? FileManager.default.removeItem(at: staging)
                throw terminalError(String(cString: error))
            }
            // fakefs keeps symlinks such as Ubuntu's /bin as files, so probe real binaries under data/.
            let exists = { (path: String) in FileManager.default.fileExists(atPath: staging.appendingPathComponent("data/" + path).path) }
            guard exists("usr/bin/dpkg") else {
                let alpine = exists("sbin/apk")
                try? FileManager.default.removeItem(at: staging)
                throw terminalError(alpine
                    ? "This backup was created by the older Alpine-based terminal and cannot be restored on Ubuntu. Install the Ubuntu terminal and create a new backup."
                    : "The selected file is not a valid Acode terminal backup.")
            }
            runtime.unmount { error in
                if let error { callback.error(error.localizedDescription); return }
                do {
                    let previous = runtime.root.appendingPathExtension("previous")
                    try? FileManager.default.removeItem(at: previous)
                    let exists = FileManager.default.fileExists(atPath: runtime.root.path)
                    if exists { try FileManager.default.moveItem(at: runtime.root, to: previous) }
                    do { try FileManager.default.moveItem(at: staging, to: runtime.root) }
                    catch {
                        if exists { try? FileManager.default.moveItem(at: previous, to: runtime.root) }
                        throw error
                    }
                    try FileManager.default.createDirectory(at: runtime.files.data.appendingPathComponent(".configured"), withIntermediateDirectories: true)
                    try? FileManager.default.removeItem(at: previous)
                    callback.success("ok")
                } catch { callback.error(error.localizedDescription) }
            }
        case "uninstall":
            runtime.unmount { error in
                if let error { callback.error(error.localizedDescription); return }
                do {
                    if FileManager.default.fileExists(atPath: runtime.root.path) { try FileManager.default.removeItem(at: runtime.root) }
                    let marker = runtime.files.data.appendingPathComponent(".configured")
                    if FileManager.default.fileExists(atPath: marker.path) { try FileManager.default.removeItem(at: marker) }
                    callback.success("ok")
                } catch { callback.error(error.localizedDescription) }
            }
        default: throw terminalError("Unknown maintenance action")
        }
    }
}
