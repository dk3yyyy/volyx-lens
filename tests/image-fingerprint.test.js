const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FINGERPRINT_WIDTH,
  FINGERPRINT_HEIGHT,
  createImageFingerprint,
  hammingDistance,
  isNearDuplicateFingerprint,
  fingerprintDataUrl,
} = require('../src/image-fingerprint');

function bitmapFor(pixel) {
  const bitmap = Buffer.alloc(FINGERPRINT_WIDTH * FINGERPRINT_HEIGHT * 4);
  for (let y = 0; y < FINGERPRINT_HEIGHT; y += 1) {
    for (let x = 0; x < FINGERPRINT_WIDTH; x += 1) {
      const value = Math.max(0, Math.min(255, Math.round(pixel(x, y))));
      const offset = ((y * FINGERPRINT_WIDTH) + x) * 4;
      bitmap[offset] = value;
      bitmap[offset + 1] = value;
      bitmap[offset + 2] = value;
      bitmap[offset + 3] = 255;
    }
  }
  return bitmap;
}

test('image fingerprint creates deterministic private 256-bit visual signatures', () => {
  const bitmap = bitmapFor((x, y) => (x * 8) + (y * 3));
  const first = createImageFingerprint(bitmap);
  const second = createImageFingerprint(Buffer.from(bitmap));
  assert.deepEqual(first, second);
  assert.match(first.differenceHash, /^[a-f0-9]{64}$/);
  assert.match(first.averageHash, /^[a-f0-9]{64}$/);
  assert.equal(hammingDistance(first.differenceHash, second.differenceHash), 0);
  assert.equal(Number.isInteger(first.meanLuma), true);
  assert.equal(Number.isInteger(first.lumaSpread), true);
});

test('conservative similarity accepts tiny bitmap changes but rejects materially different layouts', () => {
  const base = bitmapFor((x, y) => 30 + (x * 8) + ((y % 4) * 5));
  const tinyChange = Buffer.from(base);
  for (const [x, y] of [[3, 3], [12, 10]]) {
    const offset = ((y * FINGERPRINT_WIDTH) + x) * 4;
    tinyChange[offset] += 2;
    tinyChange[offset + 1] += 2;
    tinyChange[offset + 2] += 2;
  }
  const different = bitmapFor((x, y) => ((x + y) % 2 ? 220 : 25));
  const baseFingerprint = createImageFingerprint(base);
  assert.equal(isNearDuplicateFingerprint(baseFingerprint, createImageFingerprint(tinyChange)), true);
  assert.equal(isNearDuplicateFingerprint(baseFingerprint, createImageFingerprint(different)), false);
});

test('low-contrast JPEG noise uses structural and luminance checks instead of unstable average bits', () => {
  const flat = {
    differenceHash: '0'.repeat(64),
    averageHash: '0'.repeat(64),
    meanLuma: 63,
    lumaSpread: 0,
  };
  const cursorScaleChange = {
    differenceHash: `${'0'.repeat(30)}280028${'0'.repeat(28)}`,
    averageHash: 'f'.repeat(64),
    meanLuma: 63,
    lumaSpread: 0,
  };
  assert.equal(cursorScaleChange.differenceHash.length, 64);
  assert.equal(isNearDuplicateFingerprint(flat, cursorScaleChange), true);
});

test('luminance checks keep visually different flat screens distinct even when structural hashes match', () => {
  const dark = createImageFingerprint(bitmapFor(() => 20));
  const light = createImageFingerprint(bitmapFor(() => 230));
  assert.equal(dark.differenceHash, light.differenceHash);
  assert.equal(dark.averageHash, light.averageHash);
  assert.equal(isNearDuplicateFingerprint(dark, light), false);
});

test('fingerprint input and malformed comparisons fail closed', () => {
  assert.throws(() => createImageFingerprint(Buffer.alloc(4)), /17x16/);
  assert.throws(() => createImageFingerprint('not bytes'), /byte buffer/);
  assert.equal(hammingDistance('zz', 'zz'), Infinity);
  assert.equal(isNearDuplicateFingerprint(null, null), false);
  assert.equal(isNearDuplicateFingerprint({}, {}), false);
});

test('Electron adapter decodes and resizes locally without retaining the source data URL', () => {
  const bitmap = bitmapFor((x, y) => (x * 7) + y);
  let resizeOptions;
  const nativeImage = {
    createFromDataURL(value) {
      assert.equal(value, 'data:image/png;base64,AAAA');
      return {
        isEmpty: () => false,
        resize(options) {
          resizeOptions = options;
          return { getSize: () => ({ width: FINGERPRINT_WIDTH, height: FINGERPRINT_HEIGHT }), toBitmap: () => bitmap };
        },
      };
    },
  };
  const result = fingerprintDataUrl('data:image/png;base64,AAAA', nativeImage);
  assert.deepEqual(resizeOptions, { width: 17, height: 16, quality: 'good' });
  assert.equal(Object.values(result).some((value) => String(value).includes('data:image')), false);
});
