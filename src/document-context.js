const path = require('path');
const mammoth = require('mammoth');
const JSZip = require('jszip');

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 50000;
const MAX_PDF_PAGES = 50;
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 500;
const SUPPORTED_EXTENSIONS = Object.freeze(['.pdf', '.docx', '.txt', '.md']);

function cleanExtractedText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

async function validateDocxArchive(buffer) {
  const archive = await JSZip.loadAsync(buffer, { checkCRC32: false, createFolders: false });
  const entries = Object.values(archive.files);
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('The DOCX archive contains too many files.');
  let total = 0;
  for (const entry of entries) {
    const size = Number(entry && entry._data && entry._data.uncompressedSize) || 0;
    total += size;
    if (total > MAX_ARCHIVE_BYTES) throw new Error('The DOCX expands beyond the 20 MB safety limit.');
  }
  if (!archive.file('word/document.xml')) throw new Error('The selected file is not a valid DOCX document.');
}

async function parsePdfText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: true,
    stopEvent: true,
  });
  let document = null;
  try {
    document = await loadingTask.promise;
    const pages = Math.min(document.numPages, MAX_PDF_PAGES);
    const output = [];
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ disableNormalization: false });
      let pageText = '';
      for (const item of content.items || []) {
        if (!item || typeof item.str !== 'string') continue;
        pageText += item.str;
        pageText += item.hasEOL ? '\n' : ' ';
      }
      output.push(pageText.trim());
      if (typeof page.cleanup === 'function') page.cleanup();
    }
    return { text: output.filter(Boolean).join('\n\n'), pages: document.numPages, truncated: document.numPages > MAX_PDF_PAGES };
  } catch (error) {
    if (error && error.name === 'PasswordException') throw new Error('Password-protected PDFs are not supported. Remove the password and try again.');
    const detail = error && error.message ? String(error.message).replace(/[\r\n]+/g, ' ').slice(0, 240) : 'The PDF could not be parsed.';
    throw new Error(`The PDF could not be read: ${detail}`);
  } finally {
    try { if (document) await document.destroy(); }
    catch {}
    try { await loadingTask.destroy(); }
    catch {}
  }
}

async function parseContextDocument({ filePath, buffer }) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Document data is required.');
  if (!buffer.length) throw new Error('The selected document is empty.');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('Documents must be 5 MB or smaller.');
  const extension = path.extname(String(filePath || '')).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(extension)) throw new Error('Supported document types are PDF, DOCX, TXT, and Markdown.');

  let extracted = '';
  let truncated = false;
  if (extension === '.pdf') {
    if (!buffer.subarray(0, Math.min(buffer.length, 1024)).includes(Buffer.from('%PDF-', 'ascii'))) throw new Error('The selected file does not have a valid PDF signature.');
    const result = await parsePdfText(buffer);
    extracted = result.text;
    truncated = result.truncated;
  } else if (extension === '.docx') {
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error('The selected file does not have a valid DOCX signature.');
    await validateDocxArchive(buffer);
    const result = await mammoth.extractRawText({ buffer });
    extracted = result.value;
  } else {
    if (buffer.includes(0)) throw new Error('The selected text document appears to be binary.');
    try { extracted = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch { throw new Error('Text and Markdown documents must use UTF-8 encoding.'); }
  }

  const cleaned = cleanExtractedText(extracted);
  if (!cleaned) throw new Error('No readable text was found. Scanned PDFs require OCR and are not supported yet.');
  if (cleaned.length > MAX_TEXT_CHARS) truncated = true;
  const text = cleaned.slice(0, MAX_TEXT_CHARS);
  return {
    name: path.basename(filePath).slice(0, 180),
    text,
    characters: text.length,
    truncated,
    extension,
  };
}

module.exports = {
  parseContextDocument,
  cleanExtractedText,
  validateDocxArchive,
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  SUPPORTED_EXTENSIONS,
};
