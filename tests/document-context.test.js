const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { parseContextDocument, MAX_FILE_BYTES } = require('../src/document-context');

async function minimalDocx(text) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function minimalPdf(text) {
  const escaped = String(text).replace(/([()\\])/g, '\\$1');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf, 'binary')); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'binary');
}

test('document parser extracts bounded UTF-8 text and rejects disguised binary files', async () => {
  const parsed = await parseContextDocument({ filePath: '/private/Joshua Resume.md', buffer: Buffer.from('# Experience\nBuilt AI agents.\n') });
  assert.equal(parsed.name, 'Joshua Resume.md');
  assert.match(parsed.text, /Built AI agents/);
  assert.equal(parsed.truncated, false);
  await assert.rejects(() => parseContextDocument({ filePath: 'resume.txt', buffer: Buffer.from([0, 1, 2]) }), /binary/);
  await assert.rejects(() => parseContextDocument({ filePath: 'resume.exe', buffer: Buffer.from('hello') }), /Supported document types/);
  await assert.rejects(() => parseContextDocument({ filePath: 'resume.txt', buffer: Buffer.alloc(MAX_FILE_BYTES + 1) }), /5 MB/);
});

test('document parser validates and extracts DOCX text', async () => {
  const buffer = await minimalDocx('Built production AI workflows');
  const parsed = await parseContextDocument({ filePath: 'Joshua.docx', buffer });
  assert.match(parsed.text, /Built production AI workflows/);
  await assert.rejects(() => parseContextDocument({ filePath: 'fake.docx', buffer: Buffer.from('not a zip') }), /DOCX signature/);
});

test('document parser validates and extracts modern PDF text', async () => {
  const parsed = await parseContextDocument({ filePath: 'resume.pdf', buffer: minimalPdf('Modern PDF resume experience') });
  assert.match(parsed.text, /Modern PDF resume experience/);
  const prefixed = Buffer.concat([Buffer.from('\n% generated file\n'), minimalPdf('Header offset resume')]);
  const offsetParsed = await parseContextDocument({ filePath: 'offset.pdf', buffer: prefixed });
  assert.match(offsetParsed.text, /Header offset resume/);
  await assert.rejects(() => parseContextDocument({ filePath: 'broken.pdf', buffer: Buffer.from('%PDF-1.7\nnot a real document') }), /PDF could not be read/);
  await assert.rejects(() => parseContextDocument({ filePath: 'fake.pdf', buffer: Buffer.from('not pdf') }), /PDF signature/);
});
