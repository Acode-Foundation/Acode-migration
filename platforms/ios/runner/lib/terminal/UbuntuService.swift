import Foundation

final class UbuntuService: BaseService {
    private let runtime = UbuntuRuntime.shared

    override func exec(action: String, args: [Any], callback: Callback) {
        runtime.queue.async { [self] in
            do {
                switch action {
                case "isSupported": callback.success(true)
                case "isInstalled": callback.success(runtime.installed)
                case "isAxsRunning":
                    try runtime.shareFiles()
                    callback.success(TerminalServer.shared.isRunning)
                case "install": try install(callback)
                case "backup", "restore", "uninstall", "clearBackup": try UbuntuMaintenance.perform(action, callback: callback)
                case "startAxs":
                    try runtime.shareFiles()
                    let failsafe = args[safe: 0] as? Bool == true
                    let port = (args[safe: 1] as? NSNumber)?.intValue
                    let start = {
                        TerminalServer.shared.start(shell: failsafe ? "exec sh" : "exec bash --rcfile /initrc -i", port: port) { error in
                            if let error { callback.error(error.localizedDescription) } else { callback.success() }
                        }
                    }
                    if failsafe { start() } else { runtime.prepare(start) }
                case "getPort":
                    callback.success(TerminalServer.shared.currentPort)
                case "stopAxs":
                    TerminalServer.shared.stop()
                    callback.success()
                default: callback.error("Unknown Ubuntu action: \(action)")
                }
            } catch { callback.error(error.localizedDescription) }
        }
    }

    private func install(_ callback: Callback) throws {
        try runtime.extract()
        try runtime.boot()
        let setup = """
        set -e
        printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' > /etc/resolv.conf
        ln -sf /acode/axs /usr/local/bin/axs
        \(runtime.syncArtifacts)
        /bin/sh /acode-assets/init-ubuntu.sh --installing
        """
        try runtime.start(setup, listener: { kind, text in
            callback.success(["type": kind, "data": text], keep: kind != "exit")
        })
    }
}
