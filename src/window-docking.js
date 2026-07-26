'use strict';

const DOCK_SIDES = Object.freeze(['top', 'bottom', 'left', 'right']);
const DEFAULT_DOCK_SIZES = Object.freeze({
  expanded: Object.freeze({ width: 700, height: 600 }),
  collapsedHorizontal: Object.freeze({ width: 260, height: 52 }),
  collapsedVertical: Object.freeze({ width: 52, height: 220 }),
  edgeInset: 6,
});

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function validSide(side) {
  return DOCK_SIDES.includes(side) ? side : 'top';
}

function sizeFor(workArea, side, collapsed, sizes = DEFAULT_DOCK_SIZES) {
  const vertical = side === 'left' || side === 'right';
  const requested = collapsed
    ? (vertical ? sizes.collapsedVertical : sizes.collapsedHorizontal)
    : sizes.expanded;
  return {
    width: Math.min(requested.width, Math.max(1, workArea.width - (sizes.edgeInset * 2))),
    height: Math.min(requested.height, Math.max(1, workArea.height - (sizes.edgeInset * 2))),
  };
}

function dockBounds({ workArea, side, anchor, collapsed = false, sizes = DEFAULT_DOCK_SIZES }) {
  const dockSide = validSide(side);
  const inset = sizes.edgeInset;
  const size = sizeFor(workArea, dockSide, collapsed, sizes);
  const safeAnchor = anchor || {
    x: workArea.x + (workArea.width / 2),
    y: workArea.y + (workArea.height / 2),
  };
  const minX = workArea.x + inset;
  const maxX = workArea.x + workArea.width - size.width - inset;
  const minY = workArea.y + inset;
  const maxY = workArea.y + workArea.height - size.height - inset;
  let x = clamp(Math.round(safeAnchor.x - (size.width / 2)), minX, maxX);
  let y = clamp(Math.round(safeAnchor.y - (size.height / 2)), minY, maxY);

  if (dockSide === 'top') y = minY;
  if (dockSide === 'bottom') y = maxY;
  if (dockSide === 'left') x = minX;
  if (dockSide === 'right') x = maxX;

  return { x, y, width: size.width, height: size.height };
}

function edgeDistances(point, workArea) {
  return {
    top: Math.abs(point.y - workArea.y),
    bottom: Math.abs((workArea.y + workArea.height) - point.y),
    left: Math.abs(point.x - workArea.x),
    right: Math.abs((workArea.x + workArea.width) - point.x),
  };
}

function nearestDockSide({ point, workArea, previousSide, hysteresis = 24 }) {
  const distances = edgeDistances(point, workArea);
  const best = DOCK_SIDES.reduce((winner, side) => distances[side] < distances[winner] ? side : winner, 'top');
  const prior = DOCK_SIDES.includes(previousSide) ? previousSide : null;
  if (prior && distances[prior] <= distances[best] + Math.max(0, hysteresis)) return prior;
  return best;
}

function railCenter(bounds, side, sizes = DEFAULT_DOCK_SIZES) {
  const dockSide = validSide(side);
  const half = Math.round((dockSide === 'left' || dockSide === 'right')
    ? sizes.collapsedVertical.width / 2
    : sizes.collapsedHorizontal.height / 2);
  if (dockSide === 'top') return { x: Math.round(bounds.x + bounds.width / 2), y: bounds.y + half };
  if (dockSide === 'bottom') return { x: Math.round(bounds.x + bounds.width / 2), y: bounds.y + bounds.height - half };
  if (dockSide === 'left') return { x: bounds.x + half, y: Math.round(bounds.y + bounds.height / 2) };
  return { x: bounds.x + bounds.width - half, y: Math.round(bounds.y + bounds.height / 2) };
}

module.exports = {
  DOCK_SIDES,
  DEFAULT_DOCK_SIZES,
  dockBounds,
  nearestDockSide,
  railCenter,
};
