const RECAP_SINGLE_REQUEST_CHARACTERS = 48000;
const RECAP_CHUNK_CHARACTERS = 12000;
const MAX_RECAP_CHUNKS = 12;

function transcriptText(turns) {
  return (Array.isArray(turns) ? turns : [])
    .map((turn) => {
      const text = String((turn && turn.text) || '').trim();
      if (!text) return '';
      return `${turn.channel === 'you' ? 'You' : 'Them'}: ${text}`;
    })
    .filter(Boolean)
    .join('\n');
}

function splitBounded(text, maxCharacters) {
  const chunks = [];
  let remaining = String(text || '').trim();
  while (remaining.length > maxCharacters) {
    let cut = remaining.lastIndexOf('\n', maxCharacters);
    if (cut < maxCharacters * 0.6) cut = remaining.lastIndexOf(' ', maxCharacters);
    if (cut < maxCharacters * 0.6) cut = maxCharacters;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function evenlySample(chunks, maximum) {
  if (chunks.length <= maximum) return chunks;
  const selected = [];
  for (let index = 0; index < maximum; index += 1) {
    const sourceIndex = Math.round(index * (chunks.length - 1) / (maximum - 1));
    selected.push(chunks[sourceIndex]);
  }
  return selected;
}

function planMeetingRecap(turns, {
  singleRequestCharacters = RECAP_SINGLE_REQUEST_CHARACTERS,
  chunkCharacters = RECAP_CHUNK_CHARACTERS,
  maxChunks = MAX_RECAP_CHUNKS,
} = {}) {
  const text = transcriptText(turns);
  if (text.length <= singleRequestCharacters) {
    return { requiresChunking: false, sourceCharacters: text.length, chunks: text ? [text] : [], sampled: false, requestCount: text ? 1 : 0 };
  }
  const allChunks = splitBounded(text, chunkCharacters);
  const chunks = evenlySample(allChunks, maxChunks);
  return {
    requiresChunking: true,
    sourceCharacters: text.length,
    chunks,
    sampled: chunks.length < allChunks.length,
    requestCount: chunks.length + 1,
  };
}

module.exports = {
  RECAP_SINGLE_REQUEST_CHARACTERS,
  RECAP_CHUNK_CHARACTERS,
  MAX_RECAP_CHUNKS,
  transcriptText,
  splitBounded,
  planMeetingRecap,
};
