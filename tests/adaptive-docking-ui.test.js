const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

test('trusted bridge carries collapse state to main and dock state back to renderer', () => {
  assert.match(preload, /setWindowCollapsed:\s*\(collapsed\)\s*=>\s*ipcRenderer\.send\('window:set-collapsed'/);
  assert.match(preload, /'window:dock-state'/);
  assert.match(main, /onTrusted\('window:set-collapsed'/);
  assert.match(main, /send\('window:dock-state'/);
  assert.match(renderer, /volyxLens\.setWindowCollapsed\(collapsed\)/);
  assert.match(renderer, /volyxLens\.on\('window:dock-state'/);
});

test('native dragging stays free and docking occurs only when collapse is requested', () => {
  assert.match(main, /require\('\.\/src\/window-docking'\)/);
  assert.match(main, /nearestDockSide/);
  assert.match(main, /railCenter/);
  assert.match(main, /win\.setBounds\(nextBounds/);
  assert.match(main, /screen\.getDisplayMatching/);
  assert.doesNotMatch(main, /win\.on\(['"]move[d]?['"]/);
  assert.doesNotMatch(main, /scheduleWindowDock|snapWindowToNearestEdge|dockMoveTimer/);
  assert.match(main, /onTrusted\('window:set-collapsed',[\s\S]*nearestDockSide[\s\S]*applyDockBounds\(\{ side, collapsed: nextCollapsed, anchor \}\)/);
  assert.match(main, /did-finish-load[\s\S]*side:\s*windowDock\.side[\s\S]*collapsed:\s*windowDock\.collapsed/);
});

test('renderer reload preserves a freely dragged expanded window', () => {
  assert.match(main, /let rendererHasLoaded = false;/);
  assert.match(
    main,
    /if \(!rendererHasLoaded\)[\s\S]*else if \(windowDock\.collapsed\) \{\s*applyDockBounds\(windowDock\);\s*\} else \{\s*publishDockState\(\);\s*\}\s*rendererHasLoaded = true;/
  );
});

test('renderer has explicit four-edge layouts and inward panel ordering', () => {
  assert.match(html, /id="app"[^>]*data-dock="top"/);
  for (const side of ['top', 'bottom', 'left', 'right']) {
    assert.match(styles, new RegExp(`#app\\[data-dock="${side}"\\]`));
  }
  assert.match(styles, /#app\[data-dock="bottom"\][\s\S]*flex-direction:\s*column-reverse/);
  assert.match(styles, /#app\[data-dock="left"\][\s\S]*flex-direction:\s*row/);
  assert.match(styles, /#app\[data-dock="right"\][\s\S]*flex-direction:\s*row-reverse/);
  assert.match(styles, /#app\[data-dock="left"\][\s\S]*#toolbar[\s\S]*flex-direction:\s*column/);
  assert.match(styles, /#app\[data-dock="right"\][\s\S]*#toolbar[\s\S]*flex-direction:\s*column/);
});

test('the full toolbar remains the drag target while interactive controls stay no-drag', () => {
  assert.doesNotMatch(html, /class="tb-grab"/);
  assert.doesNotMatch(styles, /\.tb-grab/);
  assert.match(styles, /#toolbar\s*\{\s*-webkit-app-region:\s*drag/);
  assert.match(styles, /\.no-drag, button, input, textarea\s*\{\s*-webkit-app-region:\s*no-drag/);
});

test('opening a modal expands a collapsed native window and closing restores it', () => {
  assert.match(main, /let modalRestoreCollapsed = null/);
  assert.match(main, /const modalStateWasKnown = rendererModalStateReported[\s\S]*!modalStateWasKnown \|\| !uiModalOpen/);
  assert.match(main, /modalRestoreCollapsed === null[\s\S]*modalRestoreCollapsed = windowDock\.collapsed[\s\S]*applyDockBounds\(\{ collapsed: false, anchor \}\)/);
  assert.match(main, /onTrusted\('ui:modal-state',[\s\S]*modalRestoreCollapsed === true[\s\S]*applyDockBounds\(\{ collapsed: true, anchor \}\)/);
});
