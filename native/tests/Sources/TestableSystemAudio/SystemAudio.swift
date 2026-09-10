import Foundation

// Testable wrapper for the System Audio capture logic.
// Extracts the pure logic from macos-system-audio.swift so it can be unit tested
// without requiring actual ScreenCaptureKit hardware or audio hardware.

public struct SystemAudioConstants {
    public static let sampleRate = 24_000
    public static let frameSamples = 480
    public static let frameBytes = frameSamples * MemoryLayout<Int16>.size
    public static let maxQueuedFrames = 100
}

public enum SystemAudioEventCode: String {
    case unsupportedOS = "unsupported_os"
    case permissionDenied = "permission_denied"
    case noDisplay = "no_display"
    case streamStartFailed = "stream_start_failed"
    case streamStopped = "stream_stopped"
    case audioFormatFailed = "audio_format_failed"
    case stdoutFailed = "stdout_failed"
    case internalError = "internal_error"
}

public enum SystemAudioFrameType: UInt8 {
    case event = 1
    case pcm = 2
}

/// Represents a parsed frame header from the binary protocol.
public struct FrameHeader: Equatable {
    public let magic: [UInt8]      // Should be [0x56, 0x4C, 0x41, 0x55] ("VLAU")
    public let protocolVersion: UInt8
    public let type: UInt8
    public let reserved: UInt16
    public let length: UInt32
    public let sequence: UInt32
}

/// Builds a binary frame for the audio protocol.
/// Frame format: 4-byte magic "VLAU" + 1-byte version + 1-byte type + 2-byte reserved + 4-byte length (big-endian) + 4-byte sequence (big-endian) + payload
public func buildFrame(type: UInt8, payload: Data, sequence: UInt32) -> Data {
    var frame = Data(capacity: 16 + payload.count)
    frame.append(contentsOf: [0x56, 0x4C, 0x41, 0x55, 1, type, 0, 0])
    var length = UInt32(payload.count).bigEndian
    var seq = sequence.bigEndian
    withUnsafeBytes(of: &length) { frame.append(contentsOf: $0) }
    withUnsafeBytes(of: &seq) { frame.append(contentsOf: $0) }
    frame.append(payload)
    return frame
}

/// Parses a binary frame header from data. Returns nil if data is too short.
public func parseFrameHeader(_ data: Data) -> FrameHeader? {
    guard data.count >= 16 else { return nil }
    let magic = Array(data[0..<4])
    let protocolVersion = data[4]
    let type = data[5]
    let reserved = (UInt16(data[6]) << 8) | UInt16(data[7])
    let length = UInt32(bigEndian: data.subdata(in: 8..<12).withUnsafeBytes { $0.load(as: UInt32.self) })
    let sequence = UInt32(bigEndian: data.subdata(in: 12..<16).withUnsafeBytes { $0.load(as: UInt32.self) })
    return FrameHeader(magic: magic, protocolVersion: protocolVersion, type: type, reserved: reserved, length: length, sequence: sequence)
}

/// Checks if a frame has the correct magic bytes.
public func isValidFrameMagic(_ header: FrameHeader) -> Bool {
    return header.magic == [0x56, 0x4C, 0x41, 0x55]
}

/// Converts 32-bit float audio samples to 16-bit signed integer (little-endian).
/// Clips values to [-1.0, 1.0] before conversion.
public func floatToPCM16(_ samples: [Float]) -> Data {
    var result = Data()
    result.reserveCapacity(samples.count * 2)
    for sample in samples {
        let clamped = max(-1.0, min(1.0, Double(sample)))
        var integer = Int16((clamped * Double(Int16.max)).rounded()).littleEndian
        withUnsafeBytes(of: &integer) { result.append(contentsOf: $0) }
    }
    return result
}

/// Validates that PCM data has the correct frame size for the protocol.
public func isValidPCMFrameSize(_ data: Data) -> Bool {
    return data.count == SystemAudioConstants.frameBytes
}

/// Parses a stop command from stdin data.
/// Returns true if the data contains a stop command.
public func containsStopCommand(_ data: Data) -> Bool {
    guard let line = String(data: data, encoding: .utf8) else { return false }
    return line.contains("\"command\":\"stop\"")
}

/// Parses lines from buffered stdin data, handling newline-delimited JSON.
/// Returns an array of complete lines (without newline) and any remaining incomplete data.
public func parseLines(from buffer: inout Data, delimiter: Data = Data("\n".utf8)) -> [String] {
    var lines: [String] = []
    while let range = buffer.range(of: delimiter) {
        let lineData = Data(buffer.prefix(range.lowerBound))
        buffer.removeSubrange(0...range.lowerBound)
        if let line = String(data: lineData, encoding: .utf8) {
            lines.append(line)
        }
    }
    return lines
}

/// Builds the self-test JSON payload that the original script outputs.
public func buildSelfTestPayload() -> [String: Any] {
    return [
        "ok": true,
        "protocol": 1,
        "engine": "ScreenCaptureKit",
        "sampleRate": SystemAudioConstants.sampleRate,
        "channels": 1,
        "frameSamples": SystemAudioConstants.frameSamples
    ]
}

/// Builds a "ready" event payload.
public func buildReadyEventPayload() -> [String: Any] {
    return [
        "event": "ready",
        "format": [
            "encoding": "s16le",
            "sampleRate": SystemAudioConstants.sampleRate,
            "channels": 1,
            "frameSamples": SystemAudioConstants.frameSamples
        ]
    ]
}

/// Builds an error event payload.
public func buildErrorEventPayload(code: SystemAudioEventCode, fatal: Bool = true) -> [String: Any] {
    return [
        "event": "error",
        "code": code.rawValue,
        "fatal": fatal
    ]
}

/// Serializes a payload to JSON data.
public func serializeToJSON(_ payload: [String: Any]) -> Data? {
    return try? JSONSerialization.data(withJSONObject: payload)
}
