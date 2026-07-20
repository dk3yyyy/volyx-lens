const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const taskContext = fs.readFileSync(path.join(root, 'src', 'task-context.js'), 'utf8');
const localOcr = fs.readFileSync(path.join(root, 'src', 'local-ocr.js'), 'utf8');
const swift = fs.readFileSync(path.join(root, 'native', 'macos-vision-ocr.swift'), 'utf8');
const build = fs.readFileSync(path.join(root, 'scripts', 'build-vision-ocr.js'), 'utf8');
const verify = fs.readFileSync(path.join(root, 'scripts', 'verify-vision-ocr-package.js'), 'utf8');
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

test('macOS Vision helper is compiled, packaged, signed as a nested binary, and self-tested in CI', () => {
  assert.equal(packageJson.build.beforePack, 'scripts/build-vision-ocr.js');
  assert.deepEqual(packageJson.build.extraResources, [{ from: 'native-bin', to: 'native', filter: ['volyx-lens-vision-ocr', 'volyx-lens-system-audio'] }]);
  assert.ok(packageJson.build.mac.binaries.includes('Contents/Resources/native/volyx-lens-vision-ocr'));
  assert.ok(packageJson.build.mac.binaries.includes('Contents/Resources/native/volyx-lens-system-audio'));
  assert.match(packageJson.scripts['verify:vision-ocr-package'], /verify-vision-ocr-package/);
  assert.match(packageJson.scripts['release:mac'], /verify-vision-ocr-package/);
  assert.match(build, /xcrun/);
  assert.match(build, /swiftc/);
  assert.match(build, /macos-system-audio\.swift/);
  assert.match(build, /ScreenCaptureKit/);
  assert.match(verify, /volyx-lens-system-audio/);
  assert.match(build, /-framework', 'Vision'/);
  assert.match(verify, /--self-test/);
  assert.match(ci, /npm run verify:vision-ocr-package/);
});

test('native OCR uses Apple Vision locally with bounded stdin and JSON stdout', () => {
  assert.match(swift, /import Vision/);
  assert.match(swift, /VNRecognizeTextRequest/);
  assert.match(swift, /recognitionLevel = \.accurate/);
  assert.match(swift, /usesLanguageCorrection = false/);
  assert.match(swift, /readDataToEndOfFile/);
  assert.match(swift, /maxInputBytes = 8 \* 1024 \* 1024/);
  assert.match(swift, /maxOutputCharacters = 64 \* 1024/);
  assert.doesNotMatch(swift, /URLSession|https?:\/\//);
});

test('Add Screen queues local OCR only after storage and never turns OCR into a provider request', () => {
  const capture = main.slice(main.indexOf('async function captureTaskContextScreen'), main.indexOf('function undoTaskContext'));
  assert.match(capture, /taskContext\.add\(dataUrl, \{ ocrStatus:/);
  assert.match(capture, /publishTaskContextState\(result\)/);
  assert.match(capture, /processTaskContextOcr\(result\.addedCapture\.id/);
  assert.match(capture, /No AI request was made/);
  assert.doesNotMatch(capture, /runFeature|createLLM|streamWithFallback/);
  assert.match(localOcr, /shell: false/);
  assert.match(localOcr, /stdio: \['pipe', 'pipe', 'pipe'\]/);
  assert.match(localOcr, /const queuedJobs = \[\]/);
});

test('recognized OCR content stays private while renderer receives status and character count only', () => {
  const metadata = taskContext.slice(taskContext.indexOf('function metadata'), taskContext.indexOf('function totalBytes'));
  assert.match(metadata, /ocrStatus/);
  assert.match(metadata, /ocrCharacters/);
  assert.match(metadata, /ocrTruncated/);
  assert.doesNotMatch(metadata, /ocrText:/);
  assert.match(renderer, /Text: Processing/);
  assert.match(renderer, /Text: \$\{characters\.toLocaleString\(\)\} chars/);
  assert.match(renderer, /Text: Unavailable/);
  assert.match(html, /locally recognized text stay in main-process memory/);
  assert.doesNotMatch(preload, /ocrText|recognize|localOcr|vision-ocr/i);
  assert.doesNotMatch(renderer, /ocrText|recognizedText/);
});

test('OCR work and private text are cleared on remove, Undo, Clear, relaunch, quit, and eviction', () => {
  assert.match(main, /localOcr\.cancel\(captureId\)/);
  assert.match(main, /result\.removedCapture\) localOcr\.cancel\(result\.removedCapture\.id\)/);
  assert.match(main, /localOcr\.cancelAll\(\)/);
  assert.match(main, /pendingTaskContextOcr\.clear\(\)/);
  assert.match(main, /relaunchApp\(\)[\s\S]*?clearTaskContext\(\);[\s\S]*?app\.relaunch\(\)/);
  assert.match(main, /app\.on\('will-quit'[\s\S]*?localOcr\.cancelAll\(\)[\s\S]*?taskContext\.clear\(\)/);
  assert.match(main, /if \(!taskContext\.has\(captureId\)\) localOcr\.cancel\(captureId\)/);
});
