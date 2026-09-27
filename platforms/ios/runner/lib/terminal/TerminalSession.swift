import AcodeAlpine
import Foundation

/// One interactive shell on a guest pseudo-terminal. Output arrives on guest
/// threads; everything else runs on the terminal server's queue.
final class TerminalSession {
    private static let scrollbackLimit = 256 * 1024
    private static let unsentLimit = 1024 * 1024
    private static let frameSize = 8 * 1024
    private static let coalesceDelay = DispatchTimeInterval.milliseconds(8)
    private let queue: DispatchQueue
    private let output = NSCondition()
    private var scrollback = Data()
    private var pending = Data()
    private var unsent = 0
    private var attached = false
    private var flushScheduled = false
    private var socket: LocalWebSocket?
    private var input = Data()
    private var handle: OpaquePointer?
    private var status: Int32?
    private(set) var pid: Int32 = 0
    var onFinish: (() -> Void)?

    init(queue: DispatchQueue) {
        self.queue = queue
    }

    func started(pid: Int32, handle: OpaquePointer) {
        self.pid = pid
        self.handle = handle
    }

    /// Replays recent output, then streams live output until the socket closes.
    func attach(_ socket: LocalWebSocket) {
        if let status {
            socket.send(Self.exitMessage(status), text: true) { socket.close() }
            onFinish?()
            return
        }
        self.socket?.close()
        output.lock()
        let history = scrollback.suffix(Self.scrollbackLimit)
        pending.removeAll()
        unsent = 0
        attached = true
        output.broadcast()
        output.unlock()
        self.socket = socket
        socket.onMessage = { [weak self] data, _ in self?.write(data) }
        socket.onClose = { [weak self, weak socket] in
            guard let self, self.socket === socket else { return }
            self.detach()
        }
        if !history.isEmpty { socket.send(Data(history)) }
    }

    func resize(rows: Int, cols: Int) {
        guard let handle else { return }
        alpine_terminal_resize(handle, Int32(rows), Int32(cols))
    }

    func terminate() {
        socket?.close()
        close()
    }

    /// Called by the runtime when the shell exits.
    func finish(_ code: Int32) {
        queue.async { [self] in
            guard status == nil else { return }
            status = code
            close()
            flush()
            guard let socket else { return }
            socket.send(Self.exitMessage(code), text: true) { socket.close() }
            onFinish?()
        }
    }

    /// Runs on guest threads and blocks the writer while the client falls behind.
    func receive(_ data: Data, blocking: Bool) {
        output.lock()
        scrollback.append(data)
        if scrollback.count > Self.scrollbackLimit * 2 {
            scrollback = Data(scrollback.suffix(Self.scrollbackLimit))
        }
        guard attached else { output.unlock(); return }
        pending.append(data)
        unsent += data.count
        let immediate = pending.count >= Self.frameSize
        let schedule = !flushScheduled
        flushScheduled = true
        output.unlock()
        if immediate { queue.async { self.flush() } }
        else if schedule { queue.asyncAfter(deadline: .now() + Self.coalesceDelay) { self.flush() } }
        guard blocking else { return }
        output.lock()
        while attached, unsent > Self.unsentLimit {
            output.wait(until: Date().addingTimeInterval(0.1))
        }
        output.unlock()
    }

    private func flush() {
        output.lock()
        let data = pending
        pending.removeAll(keepingCapacity: true)
        flushScheduled = false
        output.unlock()
        guard !data.isEmpty, let socket else { return }
        socket.send(data) { [weak self] in self?.acknowledge(data.count) }
    }

    private func acknowledge(_ count: Int) {
        output.lock()
        unsent = max(0, unsent - count)
        output.broadcast()
        output.unlock()
    }

    private func detach() {
        socket = nil
        output.lock()
        attached = false
        pending.removeAll()
        unsent = 0
        output.broadcast()
        output.unlock()
    }

    private func write(_ data: Data) {
        let idle = input.isEmpty
        input.append(data)
        if idle { drainInput() }
    }

    // The guest line buffer holds 4 KiB, so large pastes are fed as the shell reads.
    private func drainInput() {
        guard let handle, !input.isEmpty else { input.removeAll(); return }
        let written = input.withUnsafeBytes { bytes in
            alpine_terminal_input(handle, bytes.bindMemory(to: CChar.self).baseAddress, bytes.count)
        }
        if written > 0 { input = Data(input.dropFirst(written)) }
        guard !input.isEmpty else { return }
        queue.asyncAfter(deadline: .now() + .milliseconds(10)) { [weak self] in self?.drainInput() }
    }

    private func close() {
        guard let handle else { return }
        self.handle = nil
        input.removeAll()
        alpine_terminal_close(handle)
    }

    private static func exitMessage(_ code: Int32) -> Data {
        let message: [String: Any] = [
            "type": "exit",
            "data": ["exit_code": code, "signal": NSNull(),
                     "message": code == 0 ? "Process exited successfully" : "Process exited with non-zero status"],
        ]
        return (try? JSONSerialization.data(withJSONObject: message)) ?? Data()
    }
}

let terminalOutput: AlpineTerminalOutput = { context, data, length, blocking in
    guard let context, let data else { return }
    Unmanaged<TerminalSession>.fromOpaque(context).takeUnretainedValue()
        .receive(Data(bytes: data, count: length), blocking: blocking)
}

let terminalRelease: AlpineTerminalRelease = { context in
    guard let context else { return }
    Unmanaged<TerminalSession>.fromOpaque(context).release()
}
