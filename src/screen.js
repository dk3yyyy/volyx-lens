// Full-resolution screenshot via desktopCapturer (main process).
// First call triggers the macOS Screen-Recording permission prompt for the app.
const { desktopCapturer, screen } = require('electron');

async function captureScreenshot({ maxWidth = null, format = 'png', quality = 80 } = {}) {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;
  const scale = primary.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.floor(width * scale), height: Math.floor(height * scale) }
  });
  if (!sources.length) return null;
  // Prefer the primary display source.
  const src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  let img = src.thumbnail;
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  if (Number.isFinite(maxWidth) && maxWidth > 0 && size.width > maxWidth) {
    img = img.resize({ width: Math.floor(maxWidth), quality: 'best' });
  }
  if (format === 'jpeg') {
    const jpeg = img.toJPEG(Math.max(1, Math.min(100, Math.floor(quality))));
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  }
  return img.toDataURL(); // data:image/png;base64,...
}

module.exports = { captureScreenshot };
