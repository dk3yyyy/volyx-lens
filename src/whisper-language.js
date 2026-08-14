// whisper.cpp's whisper_lang_id accepts ISO 639-1 base codes only (e.g. `zh`,
// `pt`, `en`). Locale-form identifiers such as `zh-TW` and the literal `auto`
// are rejected, so reduce to the base code and treat empty/`auto` as
// auto-detection (the field is then omitted entirely).
function normalizeWhisperLanguage(language) {
  const value = String(language || '').trim();
  if (!value || value.toLowerCase() === 'auto') return '';
  return value.split('-')[0].toLowerCase();
}

module.exports = { normalizeWhisperLanguage };