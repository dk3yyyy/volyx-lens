import XCTest
@testable import TestableSystemAudio

final class SystemAudioTests: XCTestCase {

    // MARK: - Constants Tests

    func testConstants_SampleRate() {
        XCTAssertEqual(SystemAudioConstants.sampleRate, 24_000)
    }

    func testConstants_FrameSamples() {
        XCTAssertEqual(SystemAudioConstants.frameSamples, 480)
    }

    func testConstants_FrameBytes() {
        XCTAssertEqual(SystemAudioConstants.frameBytes, 480 * MemoryLayout<Int16>.size)
    }

    func testConstants_MaxQueuedFrames() {
        XCTAssertEqual(SystemAudioConstants.maxQueuedFrames, 100)
    }

    // MARK: - Frame Building Tests

    func testBuildFrame_ValidatesMagicBytes() {
        let payload = Data("test".utf8)
        let frame = buildFrame(type: 1, payload: payload, sequence: 0)

        // Header is 16 bytes: 4 magic + 1 version + 1 type + 2 reserved + 4 length + 4 sequence
        XCTAssertEqual(frame.count, 16 + payload.count)

        // Check magic bytes: V=0x56, L=0x4C, A=0x41, U=0x55
        XCTAssertEqual(frame[0], 0x56)
        XCTAssertEqual(frame[1], 0x4C)
        XCTAssertEqual(frame[2], 0x41)
        XCTAssertEqual(frame[3], 0x55)

        // Check version and type
        XCTAssertEqual(frame[4], 1)
        XCTAssertEqual(frame[5], 1)
    }

    func testBuildFrame_LengthIsBigEndian() {
        let payload = Data("hello".utf8) // 5 bytes
        let frame = buildFrame(type: 2, payload: payload, sequence: 42)

        // Length is at offset 8-11 (big-endian)
        let length = UInt32(bigEndian: frame.subdata(in: 8..<12).withUnsafeBytes { $0.load(as: UInt32.self) })
        XCTAssertEqual(length, 5)
    }

    func testBuildFrame_SequenceIsBigEndian() {
        let payload = Data()
        let frame = buildFrame(type: 1, payload: payload, sequence: 0x12345678)

        // Sequence is at offset 12-15 (big-endian)
        let sequence = UInt32(bigEndian: frame.subdata(in: 12..<16).withUnsafeBytes { $0.load(as: UInt32.self) })
        XCTAssertEqual(sequence, 0x12345678)
    }

    func testBuildFrame_PayloadIsAppended() {
        let payload = Data("test data".utf8)
        let frame = buildFrame(type: 1, payload: payload, sequence: 0)

        let appendedPayload = frame.subdata(in: 16..<frame.count)
        XCTAssertEqual(appendedPayload, payload)
    }

    func testBuildFrame_EmptyPayload() {
        let payload = Data()
        let frame = buildFrame(type: 1, payload: payload, sequence: 0)

        XCTAssertEqual(frame.count, 16)
    }

    // MARK: - Frame Parsing Tests

    func testParseFrameHeader_TooShortData_ReturnsNil() {
        let shortData = Data([0x56, 0x4C, 0x41, 0x55]) // only 4 bytes
        let header = parseFrameHeader(shortData)
        XCTAssertNil(header)
    }

    func testParseFrameHeader_Exactly16Bytes_Succeeds() {
        let data = Data([
            0x56, 0x4C, 0x41, 0x55, // magic "VLAU"
            0x01,                    // version
            0x02,                    // type
            0x00, 0x00,             // reserved
            0x00, 0x00, 0x00, 0x05, // length = 5
            0x00, 0x00, 0x00, 0x01  // sequence = 1
        ])
        let header = parseFrameHeader(data)
        XCTAssertNotNil(header)
        XCTAssertEqual(header?.magic, [0x56, 0x4C, 0x41, 0x55])
        XCTAssertEqual(header?.protocolVersion, 1)
        XCTAssertEqual(header?.type, 2)
        XCTAssertEqual(header?.length, 5)
        XCTAssertEqual(header?.sequence, 1)
    }

    func testParseFrameHeader_LongerData_ParsesHeaderOnly() {
        var data = Data([
            0x56, 0x4C, 0x41, 0x55,
            0x01, 0x01,
            0x00, 0x00,
            0x00, 0x00, 0x00, 0x04,
            0x00, 0x00, 0x00, 0x02
        ])
        data.append(Data("extra payload data".utf8))
        let header = parseFrameHeader(data)
        XCTAssertNotNil(header)
        XCTAssertEqual(header?.sequence, 2)
    }

    // MARK: - Frame Magic Validation Tests

    func testIsValidFrameMagic_ValidMagic_ReturnsTrue() {
        let header = FrameHeader(
            magic: [0x56, 0x4C, 0x41, 0x55],
            protocolVersion: 1,
            type: 1,
            reserved: 0,
            length: 0,
            sequence: 0
        )
        XCTAssertTrue(isValidFrameMagic(header))
    }

    func testIsValidFrameMagic_InvalidMagic_ReturnsFalse() {
        let header = FrameHeader(
            magic: [0x00, 0x00, 0x00, 0x00],
            protocolVersion: 1,
            type: 1,
            reserved: 0,
            length: 0,
            sequence: 0
        )
        XCTAssertFalse(isValidFrameMagic(header))
    }

    func testIsValidFrameMagic_PartialMagic_ReturnsFalse() {
        let header = FrameHeader(
            magic: [0x56, 0x4C, 0x41, 0x54], // last byte wrong
            protocolVersion: 1,
            type: 1,
            reserved: 0,
            length: 0,
            sequence: 0
        )
        XCTAssertFalse(isValidFrameMagic(header))
    }

    // MARK: - Float to PCM16 Conversion Tests

    func testFloatToPCM16_ZeroInput_ProducesZero() {
        let samples: [Float] = [0.0, 0.0, 0.0]
        let data = floatToPCM16(samples)
        XCTAssertEqual(data.count, 6) // 3 samples * 2 bytes each

        // All bytes should be 0 for zero input
        for byte in data {
            XCTAssertEqual(byte, 0)
        }
    }

    func testFloatToPCM16_PositiveMax_ProducesMaxValue() {
        let samples: [Float] = [1.0]
        let data = floatToPCM16(samples)
        XCTAssertEqual(data.count, 2)

        // Should be Int16.max in little-endian = 0x7F, 0xFF
        let value = data.withUnsafeBytes { $0.load(as: Int16.self) }
        XCTAssertEqual(value, Int16.max)
    }

    func testFloatToPCM16_NegativeMax_ProducesMinValue() {
        let samples: [Float] = [-1.0]
        let data = floatToPCM16(samples)
        XCTAssertEqual(data.count, 2)

        let value = data.withUnsafeBytes { $0.load(as: Int16.self) }
        XCTAssertEqual(value, Int16.min)
    }

    func testFloatToPCM16_ClipsAboveOne() {
        let samples: [Float] = [2.0]
        let data = floatToPCM16(samples)

        let value = data.withUnsafeBytes { $0.load(as: Int16.self) }
        XCTAssertEqual(value, Int16.max) // clipped to max
    }

    func testFloatToPCM16_ClipsBelowMinusOne() {
        let samples: [Float] = [-2.0]
        let data = floatToPCM16(samples)

        let value = data.withUnsafeBytes { $0.load(as: Int16.self) }
        XCTAssertEqual(value, Int16.min) // clipped to min
    }

    func testFloatToPCM16_HalfScaleInput() {
        let samples: [Float] = [0.5]
        let data = floatToPCM16(samples)

        let value = data.withUnsafeBytes { $0.load(as: Int16.self) }
        // 0.5 * 32767 = 16383.5, rounded to 16384
        XCTAssertEqual(value, 16384)
    }

    func testFloatToPCM16_EmptyArray_ReturnsEmpty() {
        let samples: [Float] = []
        let data = floatToPCM16(samples)
        XCTAssertTrue(data.isEmpty)
    }

    func testFloatToPCM16_MultipleSamples_AllConverted() {
        let samples: [Float] = [0.25, 0.5, 0.75]
        let data = floatToPCM16(samples)
        XCTAssertEqual(data.count, 6) // 3 * 2 bytes
    }

    // MARK: - PCM Frame Size Validation Tests

    func testIsValidPCMFrameSize_CorrectSize_ReturnsTrue() {
        let data = Data(count: SystemAudioConstants.frameBytes)
        XCTAssertTrue(isValidPCMFrameSize(data))
    }

    func testIsValidPCMFrameSize_TooSmall_ReturnsFalse() {
        let data = Data(count: SystemAudioConstants.frameBytes - 1)
        XCTAssertFalse(isValidPCMFrameSize(data))
    }

    func testIsValidPCMFrameSize_TooLarge_ReturnsFalse() {
        let data = Data(count: SystemAudioConstants.frameBytes + 1)
        XCTAssertFalse(isValidPCMFrameSize(data))
    }

    func testIsValidPCMFrameSize_Empty_ReturnsFalse() {
        let data = Data()
        XCTAssertFalse(isValidPCMFrameSize(data))
    }

    // MARK: - Stop Command Parsing Tests

    func testContainsStopCommand_ValidCommand_ReturnsTrue() {
        let command = "{\"command\":\"stop\"}\n"
        let data = Data(command.utf8)
        XCTAssertTrue(containsStopCommand(data))
    }

    func testContainsStopCommand_NoCommand_ReturnsFalse() {
        let command = "{\"command\":\"start\"}\n"
        let data = Data(command.utf8)
        XCTAssertFalse(containsStopCommand(data))
    }

    func testContainsStopCommand_EmptyString_ReturnsFalse() {
        let data = Data()
        XCTAssertFalse(containsStopCommand(data))
    }

    func testContainsStopCommand_InvalidUTF8_ReturnsFalse() {
        let data = Data([0xFF, 0xFE, 0xFD])
        XCTAssertFalse(containsStopCommand(data))
    }

    func testContainsStopCommand_CommandInLargerPayload_ReturnsTrue() {
        let command = "{\"type\":\"control\",\"command\":\"stop\",\"extra\":true}\n"
        let data = Data(command.utf8)
        XCTAssertTrue(containsStopCommand(data))
    }

    // MARK: - Line Parsing Tests

    func testParseLines_SingleCompleteLine_ReturnsOneLine() {
        var buffer = Data("first line\n".utf8)
        let lines = parseLines(from: &buffer)
        XCTAssertEqual(lines.count, 1)
        XCTAssertEqual(lines[0], "first line")
        XCTAssertTrue(buffer.isEmpty)
    }

    func testParseLines_MultipleCompleteLines_ReturnsAllLines() {
        var buffer = Data("line1\nline2\nline3\n".utf8)
        let lines = parseLines(from: &buffer)
        XCTAssertEqual(lines.count, 3)
        XCTAssertEqual(lines[0], "line1")
        XCTAssertEqual(lines[1], "line2")
        XCTAssertEqual(lines[2], "line3")
    }

    func testParseLines_IncompleteLineAtEnd_PreservesRemainder() {
        var buffer = Data("complete\nincomplete".utf8)
        let lines = parseLines(from: &buffer)
        XCTAssertEqual(lines.count, 1)
        XCTAssertEqual(lines[0], "complete")
        XCTAssertEqual(String(data: buffer, encoding: .utf8), "incomplete")
    }

    func testParseLines_EmptyBuffer_ReturnsEmpty() {
        var buffer = Data()
        let lines = parseLines(from: &buffer)
        XCTAssertTrue(lines.isEmpty)
    }

    func testParseLines_NoNewline_ReturnsEmptyAndPreservesBuffer() {
        var buffer = Data("no newline here".utf8)
        let lines = parseLines(from: &buffer)
        XCTAssertTrue(lines.isEmpty)
        XCTAssertEqual(String(data: buffer, encoding: .utf8), "no newline here")
    }

    func testParseLines_OnlyNewline_ReturnsEmptyString() {
        var buffer = Data("\n".utf8)
        let lines = parseLines(from: &buffer)
        XCTAssertEqual(lines.count, 1)
        XCTAssertEqual(lines[0], "")
    }

    func testParseLines_ConsecutiveNewlines_ReturnsEmptyStrings() {
        var buffer = Data("\n\n\n".utf8)
        let lines = parseLines(from: &buffer)
        XCTAssertEqual(lines.count, 3)
        XCTAssertEqual(lines[0], "")
        XCTAssertEqual(lines[1], "")
        XCTAssertEqual(lines[2], "")
    }

    // MARK: - Self-Test Payload Tests

    func testBuildSelfTestPayload_ContainsRequiredFields() {
        let payload = buildSelfTestPayload()
        XCTAssertEqual(payload["ok"] as? Bool, true)
        XCTAssertEqual(payload["protocol"] as? Int, 1)
        XCTAssertEqual(payload["engine"] as? String, "ScreenCaptureKit")
        XCTAssertEqual(payload["sampleRate"] as? Int, 24_000)
        XCTAssertEqual(payload["channels"] as? Int, 1)
        XCTAssertEqual(payload["frameSamples"] as? Int, 480)
    }

    func testBuildSelfTestPayload_SerializableToJSON() {
        let payload = buildSelfTestPayload()
        let data = serializeToJSON(payload)
        XCTAssertNotNil(data)

        let json = try? JSONSerialization.jsonObject(with: data!, options: []) as? [String: Any]
        XCTAssertNotNil(json)
        XCTAssertEqual(json?["ok"] as? Bool, true)
    }

    // MARK: - Ready Event Payload Tests

    func testBuildReadyEventPayload_ContainsRequiredFields() {
        let payload = buildReadyEventPayload()
        XCTAssertEqual(payload["event"] as? String, "ready")

        let format = payload["format"] as? [String: Any]
        XCTAssertNotNil(format)
        XCTAssertEqual(format?["encoding"] as? String, "s16le")
        XCTAssertEqual(format?["sampleRate"] as? Int, 24_000)
        XCTAssertEqual(format?["channels"] as? Int, 1)
        XCTAssertEqual(format?["frameSamples"] as? Int, 480)
    }

    func testBuildReadyEventPayload_SerializableToJSON() {
        let payload = buildReadyEventPayload()
        let data = serializeToJSON(payload)
        XCTAssertNotNil(data)

        let json = try? JSONSerialization.jsonObject(with: data!, options: []) as? [String: Any]
        XCTAssertNotNil(json)
        XCTAssertEqual(json?["event"] as? String, "ready")
    }

    // MARK: - Error Event Payload Tests

    func testBuildErrorEventPayload_ContainsRequiredFields() {
        let payload = buildErrorEventPayload(code: .permissionDenied)
        XCTAssertEqual(payload["event"] as? String, "error")
        XCTAssertEqual(payload["code"] as? String, "permission_denied")
        XCTAssertEqual(payload["fatal"] as? Bool, true)
    }

    func testBuildErrorEventPayload_AllEventCodes() {
        let codes: [SystemAudioEventCode] = [
            .unsupportedOS, .permissionDenied, .noDisplay, .streamStartFailed,
            .streamStopped, .audioFormatFailed, .stdoutFailed, .internalError
        ]
        for code in codes {
            let payload = buildErrorEventPayload(code: code)
            XCTAssertEqual(payload["code"] as? String, code.rawValue)
        }
    }

    func testBuildErrorEventPayload_NonFatal() {
        let payload = buildErrorEventPayload(code: .streamStopped, fatal: false)
        XCTAssertEqual(payload["fatal"] as? Bool, false)
    }

    func testBuildErrorEventPayload_SerializableToJSON() {
        let payload = buildErrorEventPayload(code: .audioFormatFailed)
        let data = serializeToJSON(payload)
        XCTAssertNotNil(data)

        let json = try? JSONSerialization.jsonObject(with: data!, options: []) as? [String: Any]
        XCTAssertNotNil(json)
        XCTAssertEqual(json?["code"] as? String, "audio_format_failed")
    }

    // MARK: - Event Code Raw Value Tests

    func testEventCodeRawValues() {
        XCTAssertEqual(SystemAudioEventCode.unsupportedOS.rawValue, "unsupported_os")
        XCTAssertEqual(SystemAudioEventCode.permissionDenied.rawValue, "permission_denied")
        XCTAssertEqual(SystemAudioEventCode.noDisplay.rawValue, "no_display")
        XCTAssertEqual(SystemAudioEventCode.streamStartFailed.rawValue, "stream_start_failed")
        XCTAssertEqual(SystemAudioEventCode.streamStopped.rawValue, "stream_stopped")
        XCTAssertEqual(SystemAudioEventCode.audioFormatFailed.rawValue, "audio_format_failed")
        XCTAssertEqual(SystemAudioEventCode.stdoutFailed.rawValue, "stdout_failed")
        XCTAssertEqual(SystemAudioEventCode.internalError.rawValue, "internal_error")
    }

    // MARK: - JSON Serialization Tests

    func testSerializeToJSON_ValidPayload_ReturnsData() {
        let payload: [String: Any] = ["key": "value", "number": 42]
        let data = serializeToJSON(payload)
        XCTAssertNotNil(data)

        let json = try? JSONSerialization.jsonObject(with: data!, options: []) as? [String: Any]
        XCTAssertNotNil(json)
        XCTAssertEqual(json?["key"] as? String, "value")
        XCTAssertEqual(json?["number"] as? Int, 42)
    }

    func testSerializeToJSON_EmptyPayload_ReturnsData() {
        let payload: [String: Any] = [:]
        let data = serializeToJSON(payload)
        XCTAssertNotNil(data)

        let json = try? JSONSerialization.jsonObject(with: data!, options: []) as? [String: Any]
        XCTAssertNotNil(json)
        XCTAssertTrue(json!.isEmpty)
    }

    // MARK: - Frame Type Tests

    func testFrameType_EventValue() {
        XCTAssertEqual(SystemAudioFrameType.event.rawValue, 1)
    }

    func testFrameType_PCMValue() {
        XCTAssertEqual(SystemAudioFrameType.pcm.rawValue, 2)
    }
}
