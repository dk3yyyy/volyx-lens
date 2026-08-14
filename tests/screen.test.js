const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const screenPath = require.resolve('../src/screen');

function makeThumbnail({ width = 1920, height = 1080, empty = false, label = 'img' } = {}) {
  const make = (w, h) => ({
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    resize: (opts) => make(Math.floor(opts.width), Math.round(h * opts.width / w)),
    toJPEG: (quality) => Buffer.from(`${label}:jpeg:${quality}`),
    toDataURL: () => `data:image/png;base64,${label}:${w}x${h}`,
  });
  const image = make(width, height);
  if (empty) image.isEmpty = () => true;
  return image;
}

function loadScreen({ displays = [], sources = [], cursorDisplay = null, thumbnailSizeOptions = null } = {}) {
  let lastThumbnailSize = null;
  const fakeScreen = {
    getAllDisplays: () => displays,
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => cursorDisplay,
  };
  const fakeDesktopCapturer = {
    getSources: async (options) => {
      lastThumbnailSize = options.thumbnailSize;
      return sources;
    },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') return { desktopCapturer: fakeDesktopCapturer, screen: fakeScreen };
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[screenPath];
  try {
    return {
      captureScreenshot: require(screenPath).captureScreenshot,
      lastThumbnailSize: () => lastThumbnailSize,
    };
  } finally {
    Module._load = originalLoad;
  }
}

function display(id, { width = 1920, height = 1080, scaleFactor = 1 } = {}) {
  return { id, size: { width, height }, scaleFactor };
}

function source(displayId, thumbnail) {
  return { display_id: String(displayId), thumbnail };
}

test('uses the display nearest the cursor when no displayId is given', async () => {
  const a = display(1, { width: 1920, height: 1080, scaleFactor: 2 });
  const b = display(2, { width: 1280, height: 720, scaleFactor: 1 });
  const { captureScreenshot, lastThumbnailSize } = loadScreen({
    displays: [a, b],
    cursorDisplay: a,
    sources: [source(1, makeThumbnail({ label: 'a' })), source(2, makeThumbnail({ label: 'b' }))],
  });
  const result = await captureScreenshot();
  assert.equal(result, 'data:image/png;base64,a:1920x1080');
  assert.deepEqual(lastThumbnailSize(), { width: 3840, height: 2160 }); // scaleFactor applied
});

test('an explicit displayId selects that display and its source', async () => {
  const a = display(1);
  const b = display(2);
  const { captureScreenshot } = loadScreen({
    displays: [a, b],
    sources: [source(1, makeThumbnail({ label: 'one' })), source(2, makeThumbnail({ label: 'two' }))],
  });
  const result = await captureScreenshot({ displayId: 2 });
  assert.equal(result, 'data:image/png;base64,two:1920x1080');
});

test('an unavailable displayId rejects with a clear error', async () => {
  const a = display(1);
  const { captureScreenshot } = loadScreen({ displays: [a], sources: [source(1, makeThumbnail())] });
  await assert.rejects(() => captureScreenshot({ displayId: 99 }), /intended display is unavailable/);
});

test('returns null when desktopCapturer reports no sources', async () => {
  const a = display(1);
  const { captureScreenshot } = loadScreen({ displays: [a], sources: [], cursorDisplay: a });
  assert.equal(await captureScreenshot(), null);
});

test('rejects when no source matches the intended display', async () => {
  const a = display(1);
  const { captureScreenshot } = loadScreen({
    displays: [a],
    sources: [source(2, makeThumbnail())], // source for a different display
  });
  await assert.rejects(() => captureScreenshot(), /intended display is unavailable/);
});

test('returns null when the thumbnail is empty', async () => {
  const a = display(1);
  const { captureScreenshot } = loadScreen({
    displays: [a],
    sources: [source(1, makeThumbnail({ empty: true }))],
    cursorDisplay: a,
  });
  assert.equal(await captureScreenshot(), null);
});

test('downscales only when the capture exceeds maxWidth', async () => {
  const a = display(1);
  const big = makeThumbnail({ width: 3840, height: 2160, label: 'big' });
  const small = makeThumbnail({ width: 1024, height: 768, label: 'small' });
  const { captureScreenshot: captureBig } = loadScreen({ displays: [a], sources: [source(1, big)], cursorDisplay: a });
  const downscaled = await captureBig({ maxWidth: 1600 });
  assert.equal(downscaled, 'data:image/png;base64,big:1600x900'); // 3840 -> 1600, height keeps ratio

  const { captureScreenshot: captureSmall } = loadScreen({ displays: [a], sources: [source(1, small)], cursorDisplay: a });
  const untouched = await captureSmall({ maxWidth: 1600 });
  assert.equal(untouched, 'data:image/png;base64,small:1024x768');
});

test('jpeg format clamps quality to 1..100 and returns a jpeg data URL', async () => {
  const a = display(1);
  const { captureScreenshot: captureHigh } = loadScreen({ displays: [a], sources: [source(1, makeThumbnail({ label: 'j' }))], cursorDisplay: a });
  const high = await captureHigh({ format: 'jpeg', quality: 150 });
  assert.equal(high, `data:image/jpeg;base64,${Buffer.from('j:jpeg:100').toString('base64')}`);

  const { captureScreenshot: captureLow } = loadScreen({ displays: [a], sources: [source(1, makeThumbnail({ label: 'j' }))], cursorDisplay: a });
  const low = await captureLow({ format: 'jpeg', quality: -5 });
  assert.equal(low, `data:image/jpeg;base64,${Buffer.from('j:jpeg:1').toString('base64')}`);
});

test('rejects when there are no displays at all', async () => {
  const { captureScreenshot } = loadScreen({ displays: [], sources: [] });
  await assert.rejects(() => captureScreenshot({ displayId: 1 }), /intended display is unavailable/);
});
