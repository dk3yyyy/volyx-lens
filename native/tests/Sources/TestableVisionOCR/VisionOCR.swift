import Foundation

// Testable wrapper for the Vision OCR logic.
// Extracts the pure logic from macos-vision-ocr.swift so it can be unit tested
// without requiring actual image data or the Vision framework at test time.

public struct VisionOCRResult: Equatable {
    public let ok: Bool
    public let code: String?
    public let engine: String?
    public let text: String?
    public let truncated: Bool?

    public init(ok: Bool, code: String? = nil, engine: String? = nil, text: String? = nil, truncated: Bool? = nil) {
        self.ok = ok
        self.code = code
        self.engine = engine
        self.text = text
        self.truncated = truncated
    }

    public func toJSON() -> [String: Any] {
        var dict: [String: Any] = ["ok": ok]
        if let code = code { dict["code"] = code }
        if let engine = engine { dict["engine"] = engine }
        if let text = text { dict["text"] = text }
        if let truncated = truncated { dict["truncated"] = truncated }
        return dict
    }
}

public enum VisionOCRError: String, Equatable {
    case invalidInput = "invalid_input"
    case decodeFailed = "decode_failed"
    case recognitionFailed = "recognition_failed"
    case serializationFailed = "serialization_failed"
}

public struct VisionOCRConstants {
    public static let maxInputBytes = 8 * 1024 * 1024
    public static let maxOutputCharacters = 64 * 1024
}

/// Validates input data according to the same rules as the original script.
/// Returns nil if valid, or an error code if invalid.
public func validateInput(_ data: Data) -> VisionOCRError? {
    if data.isEmpty || data.count > VisionOCRConstants.maxInputBytes {
        return .invalidInput
    }
    return nil
}

/// Sorts observations by vertical position (top to bottom), then by horizontal position (left to right).
/// This mirrors the sorting logic in the original script.
public func sortObservations<T>(_ observations: [T], getBoundingBox: (T) -> (midY: Double, minX: Double)) -> [T] {
    return observations.sorted { left, right in
        let leftBox = getBoundingBox(left)
        let rightBox = getBoundingBox(right)
        let verticalDifference = abs(leftBox.midY - rightBox.midY)
        if verticalDifference > 0.012 { return leftBox.midY > rightBox.midY }
        return leftBox.minX < rightBox.minX
    }
}

/// Joins observation strings and truncates to maxOutputCharacters.
/// Returns the joined text and whether it was truncated.
public func joinAndTruncate(_ lines: [String]) -> (text: String, truncated: Bool) {
    let joined = lines.joined(separator: "\n")
    let bounded = String(joined.prefix(VisionOCRConstants.maxOutputCharacters))
    return (bounded, joined.count > bounded.count)
}

/// Builds the success result from recognized text lines.
public func buildSuccessResult(from lines: [String]) -> VisionOCRResult {
    let (text, truncated) = joinAndTruncate(lines)
    return VisionOCRResult(ok: true, engine: "macos-vision", text: text, truncated: truncated)
}

/// Builds an error result.
public func buildErrorResult(_ error: VisionOCRError) -> VisionOCRResult {
    return VisionOCRResult(ok: false, code: error.rawValue)
}

/// Serializes a result to JSON data.
/// Returns fallback JSON if serialization fails.
public func serializeResult(_ result: VisionOCRResult) -> Data {
    let payload = result.toJSON()
    if let data = try? JSONSerialization.data(withJSONObject: payload, options: []) {
        return data
    }
    return Data("{\"ok\":false,\"code\":\"serialization_failed\"}".utf8)
}

/// Parses a JSON string into a VisionOCRResult for test assertions.
public func parseResult(_ json: String) -> [String: Any]? {
    guard let data = json.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
        return nil
    }
    return obj
}
