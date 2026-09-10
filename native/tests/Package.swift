// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "VolyxLensNativeTests",
    platforms: [.macOS(.v13)],
    products: [],
    targets: [
        .target(
            name: "TestableVisionOCR",
            path: "Sources/TestableVisionOCR"
        ),
        .target(
            name: "TestableSystemAudio",
            path: "Sources/TestableSystemAudio"
        ),
        .testTarget(
            name: "VisionOCRTests",
            dependencies: ["TestableVisionOCR"],
            path: "Tests/VisionOCRTests"
        ),
        .testTarget(
            name: "SystemAudioTests",
            dependencies: ["TestableSystemAudio"],
            path: "Tests/SystemAudioTests"
        ),
    ]
)
