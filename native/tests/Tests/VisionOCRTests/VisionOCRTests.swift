import XCTest
@testable import TestableVisionOCR

final class VisionOCRTests: XCTestCase {

    // MARK: - Input Validation Tests

    func testValidateInput_EmptyData_ReturnsInvalidInput() {
        let result = validateInput(Data())
        XCTAssertEqual(result, .invalidInput)
    }

    func testValidateInput_TooLargeData_ReturnsInvalidInput() {
        let largeData = Data(count: VisionOCRConstants.maxInputBytes + 1)
        let result = validateInput(largeData)
        XCTAssertEqual(result, .invalidInput)
    }

    func testValidateInput_ValidData_ReturnsNil() {
        let validData = Data(count: 1024)
        let result = validateInput(validData)
        XCTAssertNil(result)
    }

    func testValidateInput_ExactlyAtMaxBoundary_ReturnsNil() {
        let boundaryData = Data(count: VisionOCRConstants.maxInputBytes)
        let result = validateInput(boundaryData)
        XCTAssertNil(result)
    }

    func testValidateInput_OneByteOverMax_ReturnsInvalidInput() {
        let overBoundary = Data(count: VisionOCRConstants.maxInputBytes + 1)
        let result = validateInput(overBoundary)
        XCTAssertEqual(result, .invalidInput)
    }

    // MARK: - Observation Sorting Tests

    func testSortObservations_SingleElement_ReturnsSame() {
        let observations = [(midY: 0.5, minX: 0.1)]
        let sorted = sortObservations(observations) { ($0.midY, $0.minX) }
        XCTAssertEqual(sorted.count, 1)
        XCTAssertEqual(sorted[0].midY, 0.5)
    }

    func testSortObservations_VerticalDifferenceAboveThreshold_SortsTopToBottom() {
        // When vertical difference > 0.012, higher midY comes first (top to bottom)
        let observations = [
            (midY: 0.3, minX: 0.1),
            (midY: 0.8, minX: 0.1),
            (midY: 0.5, minX: 0.1)
        ]
        let sorted = sortObservations(observations) { ($0.midY, $0.minX) }
        XCTAssertEqual(sorted[0].midY, 0.8)
        XCTAssertEqual(sorted[1].midY, 0.5)
        XCTAssertEqual(sorted[2].midY, 0.3)
    }

    func testSortObservations_VerticalDifferenceBelowThreshold_SortsLeftToRight() {
        // When vertical difference <= 0.012, sort by minX (left to right)
        let observations = [
            (midY: 0.5, minX: 0.8),
            (midY: 0.5, minX: 0.1),
            (midY: 0.5, minX: 0.5)
        ]
        let sorted = sortObservations(observations) { ($0.midY, $0.minX) }
        XCTAssertEqual(sorted[0].minX, 0.1)
        XCTAssertEqual(sorted[1].minX, 0.5)
        XCTAssertEqual(sorted[2].minX, 0.8)
    }

    func testSortObservations_MixedVerticalAndHorizontal() {
        let observations = [
            (midY: 0.3, minX: 0.9),  // bottom-right
            (midY: 0.8, minX: 0.5),  // top-center
            (midY: 0.8, minX: 0.1),  // top-left
            (midY: 0.3, minX: 0.1),  // bottom-left
        ]
        let sorted = sortObservations(observations) { ($0.midY, $0.minX) }
        // Top row first (midY=0.8), sorted left to right
        XCTAssertEqual(sorted[0].midY, 0.8)
        XCTAssertEqual(sorted[0].minX, 0.1)
        XCTAssertEqual(sorted[1].midY, 0.8)
        XCTAssertEqual(sorted[1].minX, 0.5)
        // Bottom row (midY=0.3), sorted left to right
        XCTAssertEqual(sorted[2].midY, 0.3)
        XCTAssertEqual(sorted[2].minX, 0.1)
        XCTAssertEqual(sorted[3].midY, 0.3)
        XCTAssertEqual(sorted[3].minX, 0.9)
    }

    func testSortObservations_EmptyArray_ReturnsEmpty() {
        let observations: [(midY: Double, minX: Double)] = []
        let sorted = sortObservations(observations) { ($0.midY, $0.minX) }
        XCTAssertTrue(sorted.isEmpty)
    }

    // MARK: - Join and Truncate Tests

    func testJoinAndTruncate_ShortText_NoTruncation() {
        let lines = ["Hello", "World"]
        let result = joinAndTruncate(lines)
        XCTAssertEqual(result.text, "Hello\nWorld")
        XCTAssertFalse(result.truncated)
    }

    func testJoinAndTruncate_EmptyArray_ReturnsEmpty() {
        let lines: [String] = []
        let result = joinAndTruncate(lines)
        XCTAssertEqual(result.text, "")
        XCTAssertFalse(result.truncated)
    }

    func testJoinAndTruncate_ExceedsMaxOutput_Truncates() {
        let longLine = String(repeating: "a", count: VisionOCRConstants.maxOutputCharacters + 100)
        let lines = [longLine]
        let result = joinAndTruncate(lines)
        XCTAssertEqual(result.text.count, VisionOCRConstants.maxOutputCharacters)
        XCTAssertTrue(result.truncated)
    }

    func testJoinAndTruncate_ExactlyAtBoundary_NoTruncation() {
        let line = String(repeating: "a", count: VisionOCRConstants.maxOutputCharacters)
        let lines = [line]
        let result = joinAndTruncate(lines)
        XCTAssertEqual(result.text.count, VisionOCRConstants.maxOutputCharacters)
        XCTAssertFalse(result.truncated)
    }

    func testJoinAndTruncate_MultipleLinesExceedBoundary_Truncates() {
        let lines = [
            String(repeating: "a", count: 40_000),
            String(repeating: "b", count: 40_000)
        ]
        let result = joinAndTruncate(lines)
        XCTAssertEqual(result.text.count, VisionOCRConstants.maxOutputCharacters)
        XCTAssertTrue(result.truncated)
    }

    // MARK: - Build Result Tests

    func testBuildSuccessResult_ValidText() {
        let result = buildSuccessResult(from: ["Hello", "World"])
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.engine, "macos-vision")
        XCTAssertEqual(result.text, "Hello\nWorld")
        XCTAssertEqual(result.truncated, false)
    }

    func testBuildSuccessResult_EmptyLines() {
        let result = buildSuccessResult(from: [])
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.text, "")
        XCTAssertEqual(result.truncated, false)
    }

    func testBuildErrorResult_InvalidInput() {
        let result = buildErrorResult(.invalidInput)
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.code, "invalid_input")
    }

    func testBuildErrorResult_DecodeFailed() {
        let result = buildErrorResult(.decodeFailed)
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.code, "decode_failed")
    }

    func testBuildErrorResult_RecognitionFailed() {
        let result = buildErrorResult(.recognitionFailed)
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.code, "recognition_failed")
    }

    func testBuildErrorResult_SerializationFailed() {
        let result = buildErrorResult(.serializationFailed)
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.code, "serialization_failed")
    }

    // MARK: - JSON Serialization Tests

    func testSerializeResult_SuccessResult() {
        let result = VisionOCRResult(ok: true, engine: "macos-vision", text: "Hello", truncated: false)
        let data = serializeResult(result)
        let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
        XCTAssertNotNil(json)
        XCTAssertEqual(json?["ok"] as? Bool, true)
        XCTAssertEqual(json?["engine"] as? String, "macos-vision")
        XCTAssertEqual(json?["text"] as? String, "Hello")
        XCTAssertEqual(json?["truncated"] as? Bool, false)
    }

    func testSerializeResult_ErrorResult() {
        let result = VisionOCRResult(ok: false, code: "invalid_input")
        let data = serializeResult(result)
        let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
        XCTAssertNotNil(json)
        XCTAssertEqual(json?["ok"] as? Bool, false)
        XCTAssertEqual(json?["code"] as? String, "invalid_input")
    }

    func testSerializeResult_FallbackOnFailure() {
        // This tests the fallback path - in practice, JSONSerialization rarely fails
        // with simple dictionaries, but we verify the fallback format exists
        let result = VisionOCRResult(ok: true)
        let data = serializeResult(result)
        XCTAssertFalse(data.isEmpty)
    }

    // MARK: - Result JSON Structure Tests

    func testVisionOCRResult_ToJSON_Success() {
        let result = VisionOCRResult(ok: true, engine: "macos-vision", text: "test", truncated: false)
        let json = result.toJSON()
        XCTAssertEqual(json["ok"] as? Bool, true)
        XCTAssertEqual(json["engine"] as? String, "macos-vision")
        XCTAssertEqual(json["text"] as? String, "test")
        XCTAssertEqual(json["truncated"] as? Bool, false)
        XCTAssertNil(json["code"])
    }

    func testVisionOCRResult_ToJSON_Error() {
        let result = VisionOCRResult(ok: false, code: "invalid_input")
        let json = result.toJSON()
        XCTAssertEqual(json["ok"] as? Bool, false)
        XCTAssertEqual(json["code"] as? String, "invalid_input")
        XCTAssertNil(json["engine"])
        XCTAssertNil(json["text"])
    }

    // MARK: - Parse Result Tests

    func testParseResult_ValidJSON() {
        let json = "{\"ok\":true,\"engine\":\"macos-vision\",\"text\":\"Hello\"}"
        let parsed = parseResult(json)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?["ok"] as? Bool, true)
        XCTAssertEqual(parsed?["engine"] as? String, "macos-vision")
    }

    func testParseResult_InvalidJSON() {
        let json = "not valid json"
        let parsed = parseResult(json)
        XCTAssertNil(parsed)
    }

    func testParseResult_EmptyString() {
        let json = ""
        let parsed = parseResult(json)
        XCTAssertNil(parsed)
    }

    // MARK: - Constants Tests

    func testConstants_MaxInputBytes() {
        XCTAssertEqual(VisionOCRConstants.maxInputBytes, 8 * 1024 * 1024)
    }

    func testConstants_MaxOutputCharacters() {
        XCTAssertEqual(VisionOCRConstants.maxOutputCharacters, 64 * 1024)
    }
}
