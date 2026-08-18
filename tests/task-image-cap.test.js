const test = require('node:test');
const assert = require('node:assert/strict');
const { capTaskImages, MAX_SAVED_TASK_IMAGES_PER_REQUEST } = require('../src/task-image-cap');

const screens = Array.from({ length: 10 }, (_, i) => `data:image/jpeg;base64,screen-${i}`);

test('task images pass through unchanged when within the provider limit', () => {
  const result = capTaskImages(screens, MAX_SAVED_TASK_IMAGES_PER_REQUEST);
  assert.deepEqual(result.images, screens);
  assert.equal(result.dropped, 0);
  assert.equal(result.total, 10);
});

test('NVIDIA one-image limit keeps only the newest screen', () => {
  const result = capTaskImages(screens, 1);
  assert.deepEqual(result.images, ['data:image/jpeg;base64,screen-9']);
  assert.equal(result.dropped, 9);
  assert.equal(result.total, 10);
});

test('capping keeps the current capture (last image) over older saved screens', () => {
  const saved = screens.slice(0, 3);
  const combined = [...saved, 'data:image/jpeg;base64,current-screen'];
  const result = capTaskImages(combined, 1);
  assert.deepEqual(result.images, ['data:image/jpeg;base64,current-screen']);
  assert.equal(result.dropped, 3);
});

test('an unset or zero limit falls back to the app-wide maximum', () => {
  const many = Array.from({ length: MAX_SAVED_TASK_IMAGES_PER_REQUEST + 5 }, (_, i) => `s${i}`);
  const result = capTaskImages(many, 0);
  assert.equal(result.images.length, MAX_SAVED_TASK_IMAGES_PER_REQUEST);
  assert.equal(result.dropped, 5);
});