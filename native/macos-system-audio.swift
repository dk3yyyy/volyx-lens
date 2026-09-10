import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreAudio

private let sampleRate = 24_000
private let frameSamples = 480
private let frameBytes = frameSamples * MemoryLayout<Int16>.size
private let maxQueuedFrames = 100

// All mutable state is protected by `lock`, so sharing this latch across
// DispatchQueue's @Sendable closures is safe.
private final class StopLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var signaled = false
    private var continuation: CheckedContinuation<Void, Never>?

    func signal() {
        lock.lock()
        if signaled { lock.unlock(); return }
        signaled = true
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume()
    }

    func wait() async {
        await withCheckedContinuation { pending in
            lock.lock()
            if signaled { lock.unlock(); pending.resume(); return }
            continuation = pending
            lock.unlock()
        }
    }
}

// Assembles stdin lines for the stop command. FileHandle's readability handler
// runs on a queue of its own, so the partial-line buffer lives behind a lock in
// this Sendable box rather than in a captured mutable local (which the
// concurrency checker rejects inside concurrently-executing code).
private final class StopCommandReader: @unchecked Sendable {
    private let lock = NSLock()
    private let delimiter = Data("\n".utf8)
    private var pending = Data()

    // Returns true once the accumulated input contains the stop command.
    func ingest(_ data: Data) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        pending.append(data)
        while let range = pending.range(of: delimiter) {
            let lineData = Data(pending.prefix(range.lowerBound))
            pending.removeSubrange(0...range.lowerBound)
            if let line = String(data: lineData, encoding: .utf8),
               line.contains("\"command\":\"stop\"") {
                return true
            }
        }
        return false
    }
}

private enum EventCode: String {
    case unsupportedOS = "unsupported_os"
    case permissionDenied = "permission_denied"
    case noDisplay = "no_display"
    case streamStartFailed = "stream_start_failed"
    case streamStopped = "stream_stopped"
    case audioFormatFailed = "audio_format_failed"
    case stdoutFailed = "stdout_failed"
    case internalError = "internal_error"
}

private final class FrameWriter {
    private let queue = DispatchQueue(label: "ai.volyx.lens.system-audio.writer")
    private let lock = NSLock()
    private var queuedPCM = 0
    private var sequence: UInt32 = 0
    private var failed = false

    func event(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object), data.count <= 65_536 else { return }
        enqueue(type: 1, payload: data, countsAsPCM: false)
    }

    func pcm(_ data: Data) {
        guard data.count == frameBytes else { return }
        lock.lock()
        if failed || queuedPCM >= maxQueuedFrames { lock.unlock(); return }
        queuedPCM += 1
        lock.unlock()
        enqueue(type: 2, payload: data, countsAsPCM: true)
    }

    private func enqueue(type: UInt8, payload: Data, countsAsPCM: Bool) {
        queue.async { [weak self] in
            guard let self else { return }
            defer {
                if countsAsPCM {
                    self.lock.lock(); self.queuedPCM = max(0, self.queuedPCM - 1); self.lock.unlock()
                }
            }
            self.lock.lock()
            let shouldWrite = !self.failed
            let currentSequence = self.sequence
            self.sequence &+= 1
            self.lock.unlock()
            guard shouldWrite else { return }
            var frame = Data(capacity: 16 + payload.count)
            frame.append(contentsOf: [0x56, 0x4c, 0x41, 0x55, 1, type, 0, 0])
            var length = UInt32(payload.count).bigEndian
            var sequence = currentSequence.bigEndian
            withUnsafeBytes(of: &length) { frame.append(contentsOf: $0) }
            withUnsafeBytes(of: &sequence) { frame.append(contentsOf: $0) }
            frame.append(payload)
            do { try FileHandle.standardOutput.write(contentsOf: frame) }
            catch { self.lock.lock(); self.failed = true; self.lock.unlock() }
        }
    }
}

@available(macOS 13.0, *)
private final class CaptureOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    private let writer: FrameWriter
    private let stopped: (EventCode) -> Void
    private var remainder = Data()

    init(writer: FrameWriter, stopped: @escaping (EventCode) -> Void) {
        self.writer = writer
        self.stopped = stopped
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        writer.event(["event": "error", "code": EventCode.streamStopped.rawValue, "fatal": true])
        stopped(.streamStopped)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .audio, CMSampleBufferDataIsReady(sampleBuffer), CMSampleBufferGetNumSamples(sampleBuffer) > 0,
              let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let asbdPointer = CMAudioFormatDescriptionGetStreamBasicDescription(description) else { return }
        let asbd = asbdPointer.pointee
        guard Int(asbd.mSampleRate.rounded()) == sampleRate, asbd.mChannelsPerFrame == 1 else {
            writer.event(["event": "error", "code": EventCode.audioFormatFailed.rawValue, "fatal": true])
            stopped(.audioFormatFailed)
            return
        }

        var needed = 0
        var blockBuffer: CMBlockBuffer?
        var status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: &needed,
            bufferListOut: nil,
            bufferListSize: 0,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &blockBuffer
        )
        guard status == noErr, needed > 0 else { return }
        let raw = UnsafeMutableRawPointer.allocate(byteCount: needed, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { raw.deallocate() }
        let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: &needed,
            bufferListOut: list,
            bufferListSize: needed,
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &blockBuffer
        )
        guard status == noErr else { return }
        // `blockBufferOut` is declared CM_RETURNS_RETAINED_PARAMETER, so the Swift
        // importer hands us an owned CMBlockBuffer that ARC releases when this scope
        // ends. Releasing it by hand (CFRelease) is unavailable in Swift and would
        // over-release the buffer, so no explicit release belongs here.
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        guard let first = buffers.first, let dataPointer = first.mData else { return }
        let byteCount = Int(first.mDataByteSize)
        var converted = Data()
        if asbd.mFormatID == kAudioFormatLinearPCM && (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0 && asbd.mBitsPerChannel == 32 {
            let count = byteCount / MemoryLayout<Float>.size
            let samples = dataPointer.assumingMemoryBound(to: Float.self)
            converted.reserveCapacity(count * 2)
            for index in 0..<count {
                let value = max(-1.0, min(1.0, samples[index]))
                var integer = Int16((value * Float(Int16.max)).rounded()).littleEndian
                withUnsafeBytes(of: &integer) { converted.append(contentsOf: $0) }
            }
        } else if asbd.mFormatID == kAudioFormatLinearPCM && (asbd.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0 && asbd.mBitsPerChannel == 16 {
            converted.append(dataPointer.assumingMemoryBound(to: UInt8.self), count: byteCount)
        } else {
            writer.event(["event": "error", "code": EventCode.audioFormatFailed.rawValue, "fatal": true])
            stopped(.audioFormatFailed)
            return
        }
        remainder.append(converted)
        while remainder.count >= frameBytes {
            writer.pcm(Data(remainder.prefix(frameBytes)))
            remainder.removeFirst(frameBytes)
        }
    }
}

@available(macOS 13.0, *)
private final class CaptureController {
    private let writer = FrameWriter()
    private let audioQueue = DispatchQueue(label: "ai.volyx.lens.system-audio.capture", qos: .userInitiated)
    private var stream: SCStream?
    private var output: CaptureOutput?
    private var stopping = false
    private let stopped = StopLatch()

    func run() async -> Int32 {
        writer.event(["event": "starting", "protocol": 1])
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let display = content.displays.sorted(by: { $0.displayID < $1.displayID }).first else {
                writer.event(["event": "error", "code": EventCode.noDisplay.rawValue, "fatal": true]); return 3
            }
            let ownPID = ProcessInfo.processInfo.processIdentifier
            let excluded = content.applications.filter { $0.processID == ownPID || $0.bundleIdentifier == "ai.volyx.lens" }
            let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
            let configuration = SCStreamConfiguration()
            configuration.capturesAudio = true
            configuration.excludesCurrentProcessAudio = true
            configuration.sampleRate = sampleRate
            configuration.channelCount = 1
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            let stopLatch = stopped
            let captureOutput = CaptureOutput(writer: writer) { _ in stopLatch.signal() }
            let captureStream = SCStream(filter: filter, configuration: configuration, delegate: captureOutput)
            try captureStream.addStreamOutput(captureOutput, type: .audio, sampleHandlerQueue: audioQueue)
            output = captureOutput
            stream = captureStream
            try await captureStream.startCapture()
            writer.event(["event": "ready", "format": ["encoding": "s16le", "sampleRate": sampleRate, "channels": 1, "frameSamples": frameSamples]])
            // This reader deliberately does not capture `self`: CaptureController is
            // not Sendable, so any `self` capture inside this concurrently-executing
            // block is a Swift 6 sendability violation (escalated to an error by
            // -warnings-as-errors). Only Sendable state is shared with the handler: the
            // StopLatch and the lock-guarded StopCommandReader.
            DispatchQueue.global().async {
                let fileHandle = FileHandle.standardInput
                let stopCommand = StopCommandReader()
                fileHandle.readabilityHandler = { handle in
                    let data = handle.availableData
                    if data.isEmpty {
                        DispatchQueue.global().async {
                            stopLatch.signal()
                        }
                        return
                    }
                    if stopCommand.ingest(data) {
                        stopLatch.signal()
                    }
                }
            }
            await stopped.wait()
            stopping = true
            try? await captureStream.stopCapture()
            writer.event(["event": "stopped", "reason": "requested"])
            usleep(100_000)
            return 0
        } catch {
            let nsError = error as NSError
            let code: EventCode = nsError.domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" && nsError.code == -3801 ? .permissionDenied : .streamStartFailed
            writer.event(["event": "error", "code": code.rawValue, "fatal": true])
            FileHandle.standardError.write(Data("system_audio_failure\n".utf8))
            usleep(100_000)
            return 2
        }
    }
}

@main
private struct Main {
    static func main() async {
        if CommandLine.arguments.contains("--self-test") {
            let payload: [String: Any] = ["ok": true, "protocol": 1, "engine": "ScreenCaptureKit", "sampleRate": sampleRate, "channels": 1, "frameSamples": frameSamples]
            let data = try! JSONSerialization.data(withJSONObject: payload)
            FileHandle.standardOutput.write(data)
            exit(0)
        }
        guard CommandLine.arguments.contains("--capture") else { exit(64) }
        guard #available(macOS 13.0, *) else { exit(69) }
        let controller = CaptureController()
        exit(await controller.run())
    }
}
