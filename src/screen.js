// Full-resolution screenshot via desktopCapturer (main process).
// First call triggers the macOS Screen-Recording permission prompt for the app.
const { desktopCapturer, screen } = require('electron');

// Vision providers downscale anything past roughly 1568 px on the long edge, and
// a Retina PNG of a busy screen is several megabytes, so request captures are
// encoded at this cap. Task Context previews pass their own smaller size.
const MAX_LONG_EDGE_PX = 1568;
const REQUEST_JPEG_QUALITY = 70;

/**
 * Downscale a NativeImage to the long-edge cap (never upscale) and encode it.
 * Duck-typed on getSize / resize / toJPEG / toDataURL so it is unit-testable
 * without a display.
 */
function encodeCapture(img, { maxWidth = 0, maxLongEdge = MAX_LONG_EDGE_PX, format = 'png', quality = 80 } = {}) {
  const { width, height } = img.getSize();
  const cap = Number.isFinite(maxLongEdge) && maxLongEdge > 0 ? Math.floor(maxLongEdge) : 0;
  const widthCap = Number.isFinite(maxWidth) && maxWidth > 0 ? Math.floor(maxWidth) : 0;
  let out = img;
  if (cap && (width > cap || height > cap)) {
    out = width >= height ? img.resize({ width: cap, quality: 'best' }) : img.resize({ height: cap, quality: 'best' });
  } else if (widthCap && width > widthCap) {
    out = img.resize({ width: widthCap, quality: 'best' });
  }
  if (format === 'jpeg') {
    const jpeg = out.toJPEG(Math.max(1, Math.min(100, Math.floor(quality))));
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  }
  return out.toDataURL(); // data:image/png;base64,...
}

async function captureScreenshot({ maxWidth = null, maxLongEdge = null, format = 'png', quality = 80, displayId = null } = {}) {
  const displays = screen.getAllDisplays();
  const selected = displayId == null
    ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    : displays.find((display) => String(display.id) === String(displayId));
  if (!selected) throw new Error('The intended display is unavailable; capture was canceled.');
  const { width, height } = selected.size;
  const scale = selected.scaleFactor || 1;
  const nativeWidth = Math.max(1, Math.floor(width * scale));
  const nativeHeight = Math.max(1, Math.floor(height * scale));
  // Size the capture up front so a 5K display is never encoded at native size.
  const longEdgeCap = Number.isFinite(maxLongEdge) && maxLongEdge > 0 ? Math.floor(maxLongEdge) : 0;
  const longEdgeScale = longEdgeCap ? Math.min(1, longEdgeCap / Math.max(nativeWidth, nativeHeight)) : 1;
  const widthCap = Number.isFinite(maxWidth) && maxWidth > 0 ? Math.floor(maxWidth) : nativeWidth;
  const requestedWidth = Math.max(1, Math.min(nativeWidth, Math.floor(widthCap * longEdgeScale)));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: requestedWidth,
      height: Math.max(1, Math.floor(nativeHeight * requestedWidth / nativeWidth)),
    }
  });
  if (!sources.length) return null;
  const source = sources.find((item) => String(item.display_id) === String(selected.id));
  if (!source) throw new Error('The intended display is unavailable; capture was canceled.');
  const img = source.thumbnail;
  if (!img || img.isEmpty()) return null;
  return encodeCapture(img, { maxWidth: Number.isFinite(maxWidth) ? maxWidth : 0, maxLongEdge: longEdgeCap, format, quality });
}

module.exports = { captureScreenshot, encodeCapture, MAX_LONG_EDGE_PX, REQUEST_JPEG_QUALITY };
