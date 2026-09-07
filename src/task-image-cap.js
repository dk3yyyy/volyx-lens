const MAX_SAVED_TASK_IMAGES_PER_REQUEST = 39;

// Providers may cap images per prompt (e.g. NVIDIA accepts at most 1). This
// caps the combined saved + current screen set so a multi-screen Task Context
// request is not rejected after capture.
//
// Explicitly pinned saved screens win: they represent user intent and must not
// be silently dropped to make room for a newer capture. The remaining budget
// goes to the newest screens (the current capture is last in the input order,
// so it is preferred over older saved screens).
//
// `pinned` is an optional boolean array parallel to `images` marking which
// input images are pinned saved screens.
function capTaskImages(images, limit, { pinned = [] } = {}) {
  const max = Math.max(1, Number(limit) || MAX_SAVED_TASK_IMAGES_PER_REQUEST);
  const total = Array.isArray(images) ? images.length : 0;
  if (total <= max) return { images: images.slice(), dropped: 0, total };
  const flags = Array.isArray(pinned) && pinned.length === total ? pinned : images.map(() => false);
  const pinnedImages = [];
  const others = [];
  images.forEach((image, index) => (flags[index] ? pinnedImages : others).push(image));
  const pinnedBudget = Math.min(max, pinnedImages.length);
  const keptOthers = others.slice(Math.max(0, others.length - (max - pinnedBudget)));
  return { images: [...pinnedImages, ...keptOthers], dropped: total - max, total };
}

module.exports = { capTaskImages, MAX_SAVED_TASK_IMAGES_PER_REQUEST };
