const MAX_SAVED_TASK_IMAGES_PER_REQUEST = 39;

// Providers may cap images per prompt (e.g. NVIDIA accepts at most 1). This
// caps the combined saved + current screen set, keeping the newest captures,
// so a multi-screen Task Context request is not rejected after capture.
function capTaskImages(images, limit) {
  const max = Math.max(1, Number(limit) || MAX_SAVED_TASK_IMAGES_PER_REQUEST);
  const total = Array.isArray(images) ? images.length : 0;
  if (total <= max) return { images: images.slice(), dropped: 0, total };
  return { images: images.slice(total - max), dropped: total - max, total };
}

module.exports = { capTaskImages, MAX_SAVED_TASK_IMAGES_PER_REQUEST };