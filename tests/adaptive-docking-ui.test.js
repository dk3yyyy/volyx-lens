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

test('native dragging stays free and docking occurs only when hide or show is requested', () => {
  assert.match(main, /require\('\.\/src\/window-docking'\)/);
  assert.match(main, /dockSideForIntent/);
  assert.match(main, /railCenter/);
  assert.match(main, /win\.setBounds\(nextBounds/);
  assert.match(main, /screen\.getDisplayNearestPoint/);
  assert.doesNotMatch(main, /win\.on\(['"]move[d]?['"]/);
  assert.doesNotMatch(main, /scheduleWindowDock|snapWindowToNearestEdge|dockMoveTimer/);
  assert.match(main, /onTrusted\('window:set-collapsed',[\s\S]*dockSideForIntent[\s\S]*applyDockBounds\(\{ side, collapsed: nextCollapsed, anchor \}\)/);
  assert.match(main, /did-finish-load[\s\S]*side:\s*windowDock\.side[\s\S]*collapsed:\s*windowDock\.collapsed/);
});

test('hide and show both resolve fresh edge intent from the visible rail position', () => {
  assert.match(main, /dockIntentPoint/);
  assert.match(main, /dockSideForIntent/);
  assert.match(
    main,
    /onTrusted\('window:set-collapsed',[\s\S]*dockIntentPoint\(\{[\s\S]*collapsed:\s*windowDock\.collapsed[\s\S]*dockSideForIntent\([\s\S]*applyDockBounds\(\{ side, collapsed: nextCollapsed, anchor \}\)/
  );
});

test('final dock bounds select the same display as the visible rail anchor', () => {
  assert.match(
    main,
    /function applyDockBounds[\s\S]*const resolvedAnchor[\s\S]*screen\.getDisplayNearestPoint\(resolvedAnchor\)[\s\S]*dockBounds\(\{ workArea: display\.workArea/
  );
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

test('the expanded panel uses a transparent scrollbar track instead of a bright native strip', () => {
  assert.match(styles, /#panel\s*\{[^}]*scrollbar-width:\s*thin[^}]*scrollbar-color:\s*transparent transparent/);
  assert.match(styles, /#panel::\-webkit-scrollbar-track\s*\{[^}]*background:\s*transparent/);
  assert.match(styles, /#panel::\-webkit-scrollbar-thumb\s*\{[^}]*background:\s*transparent/);
  assert.match(styles, /#panel:hover::\-webkit-scrollbar-thumb\s*\{[^}]*background:\s*rgba\(255,255,255,0\.22\)/);
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
  assert.match(main, /modalRestoreCollapsed === null[\s\S]*modalRestoreCollapsed = windowDock\.collapsed/);
  assert.match(
    main,
    /onTrusted\('ui:modal-state',[\s\S]*if \(windowDock\.collapsed[\s\S]*dockIntentPoint\([\s\S]*dockSideForIntent\([\s\S]*applyDockBounds\(\{ side, collapsed: false, anchor \}\)/
  );
  assert.match(main, /onTrusted\('ui:modal-state',[\s\S]*modalRestoreCollapsed === true[\s\S]*applyDockBounds\(\{ collapsed: true, anchor \}\)/);
});
