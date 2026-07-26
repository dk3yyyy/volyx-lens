const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_DOCK_SIZES,
  dockBounds,
  nearestDockSide,
  railCenter,
} = require('../src/window-docking');

const workArea = { x: 100, y: 40, width: 1440, height: 900 };

test('expanded dock bounds stay in the work area and use the selected edge', () => {
  const anchor = { x: 900, y: 490 };
  const expected = {
    top: { x: 550, y: 46, width: 700, height: 600 },
    bottom: { x: 550, y: 334, width: 700, height: 600 },
    left: { x: 106, y: 190, width: 700, height: 600 },
    right: { x: 834, y: 190, width: 700, height: 600 },
  };
  for (const side of Object.keys(expected)) {
    assert.deepEqual(dockBounds({ workArea, side, anchor, collapsed: false }), expected[side]);
  }
});

test('collapsed rail is horizontal at top and bottom and vertical at left and right', () => {
  const anchor = { x: 900, y: 490 };
  for (const side of ['top', 'bottom']) {
    const bounds = dockBounds({ workArea, side, anchor, collapsed: true });
    assert.ok(bounds.width > bounds.height, `${side} rail should be horizontal`);
  }
  for (const side of ['left', 'right']) {
    const bounds = dockBounds({ workArea, side, anchor, collapsed: true });
    assert.ok(bounds.height > bounds.width, `${side} rail should be vertical`);
  }
  assert.deepEqual(DEFAULT_DOCK_SIZES.collapsedHorizontal, { width: 260, height: 52 });
  assert.deepEqual(DEFAULT_DOCK_SIZES.collapsedVertical, { width: 52, height: 220 });
});

test('dock bounds preserve the dragged rail center along an edge and clamp at corners', () => {
  assert.equal(dockBounds({ workArea, side: 'top', anchor: { x: 115, y: 40 }, collapsed: false }).x, 106);
  assert.equal(dockBounds({ workArea, side: 'right', anchor: { x: 1540, y: 925 }, collapsed: false }).y, 334);
});

test('nearest edge uses rail center and keeps the previous side inside corner hysteresis', () => {
  assert.equal(nearestDockSide({ point: { x: 820, y: 925 }, workArea }), 'bottom');
  assert.equal(nearestDockSide({ point: { x: 112, y: 480 }, workArea }), 'left');
  assert.equal(nearestDockSide({ point: { x: 1528, y: 480 }, workArea }), 'right');
  assert.equal(nearestDockSide({ point: { x: 120, y: 58 }, workArea, previousSide: 'left', hysteresis: 24 }), 'left');
});

test('rail center follows the selected side of an expanded window', () => {
  const bounds = { x: 300, y: 200, width: 700, height: 600 };
  assert.deepEqual(railCenter(bounds, 'top'), { x: 650, y: 226 });
  assert.deepEqual(railCenter(bounds, 'bottom'), { x: 650, y: 774 });
  assert.deepEqual(railCenter(bounds, 'left'), { x: 326, y: 500 });
  assert.deepEqual(railCenter(bounds, 'right'), { x: 974, y: 500 });
});

test('dock geometry supports secondary displays with negative origins and different work areas', () => {
  const displays = [
    { x: -1920, y: 0, width: 1920, height: 1040 },
    { x: 1440, y: -300, width: 1280, height: 720 },
  ];
  for (const area of displays) {
    for (const side of ['top', 'bottom', 'left', 'right']) {
      const anchor = { x: area.x + area.width / 2, y: area.y + area.height / 2 };
      const bounds = dockBounds({ workArea: area, side, anchor });
      assert.ok(bounds.x >= area.x, `${side} x must remain on its display`);
      assert.ok(bounds.y >= area.y, `${side} y must remain on its display`);
      assert.ok(bounds.x + bounds.width <= area.x + area.width, `${side} width must remain on its display`);
      assert.ok(bounds.y + bounds.height <= area.y + area.height, `${side} height must remain on its display`);
      assert.equal(nearestDockSide({ point: railCenter(bounds, side), workArea: area, previousSide: side }), side);
    }
  }
});
