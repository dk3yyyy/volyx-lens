const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_DOCK_SIZES,
  dockBounds,
  dockIntentPoint,
  dockSideForIntent,
  nearestDockSide,
  railCenter,
  sameBounds,
} = require('../src/window-docking');

test('same bounds compares the complete native window rectangle', () => {
  const bounds = { x: 10, y: 20, width: 700, height: 600 };
  assert.equal(sameBounds(bounds, { ...bounds }), true);
  assert.equal(sameBounds(bounds, { ...bounds, y: 21 }), false);
  assert.equal(sameBounds(bounds, null), false);
});

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
    const bounds = dockBounds({ workArea, side, anchor, collapsed: false });
    // Geometry only: the bounds also report whether the dock had to fall back to
    // the rail form, which this test is not about.
    assert.deepEqual(
      { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      expected[side],
      `side ${side}`,
    );
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

test('dock intent uses side zones before splitting the center into top and bottom halves', () => {
  assert.equal(dockSideForIntent({ point: { x: 820, y: 100 }, workArea }), 'top');
  assert.equal(dockSideForIntent({ point: { x: 820, y: 925 }, workArea }), 'bottom');
  assert.equal(dockSideForIntent({ point: { x: 300, y: 925 }, workArea }), 'left');
  assert.equal(dockSideForIntent({ point: { x: 1400, y: 100 }, workArea }), 'right');
});

test('dock intent point follows the visible rail when expanded and the moved window center when collapsed', () => {
  const bounds = { x: 300, y: 200, width: 700, height: 600 };
  assert.deepEqual(dockIntentPoint({ bounds, collapsed: false, side: 'bottom' }), { x: 650, y: 774 });
  assert.deepEqual(dockIntentPoint({ bounds, collapsed: true, side: 'top' }), { x: 650, y: 500 });
});

test('dock intent supports displays with negative origins', () => {
  const area = { x: -1920, y: -200, width: 1920, height: 1080 };
  assert.equal(dockSideForIntent({ point: { x: -1800, y: 700 }, workArea: area }), 'left');
  assert.equal(dockSideForIntent({ point: { x: -960, y: 800 }, workArea: area }), 'bottom');
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

test('an expanded dock never asks for a window below the app minimum', () => {
  const bounds = dockBounds({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, side: 'top' });
  assert.equal(bounds.collapsed, false);
  assert.ok(bounds.width >= 500 && bounds.height >= 480, `got ${bounds.width}x${bounds.height}`);
});

test('a work area too small for the minimum falls back to the rail form inside it', () => {
  for (const [width, height] of [[320, 240], [480, 400], [500, 480]]) {
    const workArea = { x: 0, y: 0, width, height };
    const bounds = dockBounds({ workArea, side: 'top', collapsed: false });
    assert.equal(bounds.collapsed, true, `${width}x${height} cannot hold a 500x480 window`);
    assert.ok(bounds.width <= width - 12, `rail width ${bounds.width} fits in ${width}`);
    assert.ok(bounds.height <= height - 12, `rail height ${bounds.height} fits in ${height}`);
    assert.ok(bounds.x >= workArea.x && bounds.y >= workArea.y, 'the window starts inside the work area');
    assert.ok(bounds.x + bounds.width <= width && bounds.y + bounds.height <= height, 'and ends inside it');
  }
});

test('a work area that can hold the minimum gets a minimum-sized window, not a rail', () => {
  const workArea = { x: 0, y: 0, width: 520, height: 500 };
  const bounds = dockBounds({ workArea, side: 'top', collapsed: false });
  assert.equal(bounds.collapsed, false);
  assert.ok(bounds.width >= 500, `width ${bounds.width} clears the minimum`);
  assert.ok(bounds.height >= 480, `height ${bounds.height} clears the minimum`);
  assert.ok(bounds.width <= 508 && bounds.height <= 488, 'and still fits the usable area');
});

test('a saved smaller window is lifted to the minimum, not left below it', () => {
  const sizes = { ...DEFAULT_DOCK_SIZES, expanded: { width: 380, height: 300 } };
  const bounds = dockBounds({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, side: 'left', sizes });
  assert.equal(bounds.collapsed, false);
  assert.ok(bounds.width >= 500 && bounds.height >= 480, 'the floor wins over a bad stored size');
});

test('the dock path adopts a forced collapse instead of fighting the minimum size', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  // Without this, the window is sized to the rail and then given the 500x480
  // minimum a line later, which pushes it back over the work area.
  assert.match(mainSource, /const effectiveCollapsed = nextBounds\.collapsed === true;/);
  assert.match(mainSource, /windowDock = \{ side, collapsed: effectiveCollapsed, anchor: resolvedAnchor \};/);
  assert.match(mainSource, /if \(effectiveCollapsed\) win\.setMinimumSize\(1, 1\);/);
  assert.match(mainSource, /if \(!effectiveCollapsed\) win\.setMinimumSize\(500, 480\);/);
});
