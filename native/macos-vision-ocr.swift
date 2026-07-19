import AppKit
import Darwin
import Foundation
import Vision

private let maxInputBytes = 8 * 1024 * 1024
private let maxOutputCharacters = 64 * 1024

private func finish(_ payload: [String: Any], code: Int32 = 0) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: payload, options: [])) ?? Data("{\"ok\":false,\"code\":\"serialization_failed\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    Darwin.exit(code)
}

if CommandLine.arguments.contains("--self-test") {
    finish(["ok": true, "engine": "macos-vision", "version": 1])
}

let input = FileHandle.standardInput.readDataToEndOfFile()
if input.isEmpty || input.count > maxInputBytes {
    finish(["ok": false, "code": "invalid_input"], code: 2)
}

guard let image = NSImage(data: input) else {
    finish(["ok": false, "code": "decode_failed"], code: 3)
}

var proposedRect = NSRect(origin: .zero, size: image.size)
guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
    finish(["ok": false, "code": "decode_failed"], code: 3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.minimumTextHeight = 0.006

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    finish(["ok": false, "code": "recognition_failed"], code: 4)
}

let observations = (request.results ?? []).sorted { left, right in
    let verticalDifference = abs(left.boundingBox.midY - right.boundingBox.midY)
    if verticalDifference > 0.012 { return left.boundingBox.midY > right.boundingBox.midY }
    return left.boundingBox.minX < right.boundingBox.minX
}

let lines = observations.compactMap { observation in
    observation.topCandidates(1).first?.string
}
let joined = lines.joined(separator: "\n")
let bounded = String(joined.prefix(maxOutputCharacters))
finish(["ok": true, "engine": "macos-vision", "text": bounded, "truncated": joined.count > bounded.count])
