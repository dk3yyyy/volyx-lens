const FINGERPRINT_WIDTH = 17;
const FINGERPRINT_HEIGHT = 16;
const HASH_HEX_LENGTH = 64;

function bitsToHex(bits) {
  let value = '';
  for (let index = 0; index < bits.length; index += 4) {
    let nibble = 0;
    for (let bit = 0; bit < 4; bit += 1) nibble = (nibble << 1) | (bits[index + bit] ? 1 : 0);
    value += nibble.toString(16);
  }
  return value;
}

function luminance(bitmap, index) {
  const offset = index * 4;
  return (Number(bitmap[offset]) + Number(bitmap[offset + 1]) + Number(bitmap[offset + 2])) / 3;
}

function createImageFingerprint(bitmap, width = FINGERPRINT_WIDTH, height = FINGERPRINT_HEIGHT) {
  if (!Buffer.isBuffer(bitmap) && !(bitmap instanceof Uint8Array)) throw new TypeError('Image bitmap must be a byte buffer.');
  if (width !== FINGERPRINT_WIDTH || height !== FINGERPRINT_HEIGHT || bitmap.length < width * height * 4) {
    throw new Error(`Image bitmap must contain a ${FINGERPRINT_WIDTH}x${FINGERPRINT_HEIGHT} four-channel image.`);
  }

  const values = Array.from({ length: width * height }, (_, index) => luminance(bitmap, index));
  const cells = [];
  const differenceBits = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const left = values[(y * width) + x];
      const right = values[(y * width) + x + 1];
      differenceBits.push(left > right);
      cells.push((left + right) / 2);
    }
  }

  const mean = cells.reduce((sum, value) => sum + value, 0) / cells.length;
  const variance = cells.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / cells.length;
  const averageBits = cells.map((value) => value >= mean);
  return {
    differenceHash: bitsToHex(differenceBits),
    averageHash: bitsToHex(averageBits),
    meanLuma: Math.round(mean),
    lumaSpread: Math.round(Math.sqrt(variance)),
  };
}

function hammingDistance(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length || !/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) {
    return Number.POSITIVE_INFINITY;
  }
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    let xor = parseInt(left[index], 16) ^ parseInt(right[index], 16);
    while (xor) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return distance;
}

function isNearDuplicateFingerprint(left, right, {
  maxDifferenceDistance = 5,
  maxAverageDistance = 5,
  maxMeanDifference = 4,
  maxSpreadDifference = 6,
} = {}) {
  if (!left || !right
    || typeof left.differenceHash !== 'string' || typeof right.differenceHash !== 'string'
    || typeof left.averageHash !== 'string' || typeof right.averageHash !== 'string') return false;
  if (left.differenceHash.length !== HASH_HEX_LENGTH || right.differenceHash.length !== HASH_HEX_LENGTH
    || left.averageHash.length !== HASH_HEX_LENGTH || right.averageHash.length !== HASH_HEX_LENGTH) return false;
  const lowContrastPair = Number(left.lumaSpread) <= 6 && Number(right.lumaSpread) <= 6;
  return hammingDistance(left.differenceHash, right.differenceHash) <= maxDifferenceDistance
    && (lowContrastPair || hammingDistance(left.averageHash, right.averageHash) <= maxAverageDistance)
    && Math.abs(Number(left.meanLuma) - Number(right.meanLuma)) <= maxMeanDifference
    && Math.abs(Number(left.lumaSpread) - Number(right.lumaSpread)) <= maxSpreadDifference;
}

function fingerprintDataUrl(dataUrl, nativeImage) {
  if (!nativeImage || typeof nativeImage.createFromDataURL !== 'function') throw new TypeError('Electron nativeImage is unavailable.');
  const image = nativeImage.createFromDataURL(dataUrl);
  if (!image || image.isEmpty()) throw new Error('Image could not be decoded for local fingerprinting.');
  const resized = image.resize({ width: FINGERPRINT_WIDTH, height: FINGERPRINT_HEIGHT, quality: 'good' });
  const size = resized.getSize();
  if (size.width !== FINGERPRINT_WIDTH || size.height !== FINGERPRINT_HEIGHT) throw new Error('Image fingerprint resize returned an unexpected size.');
  return createImageFingerprint(resized.toBitmap(), size.width, size.height);
}

module.exports = {
  FINGERPRINT_WIDTH,
  FINGERPRINT_HEIGHT,
  HASH_HEX_LENGTH,
  createImageFingerprint,
  hammingDistance,
  isNearDuplicateFingerprint,
  fingerprintDataUrl,
};
