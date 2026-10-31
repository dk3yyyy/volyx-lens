'use strict';

// Meeting history used to be off by default. New profiles now inherit an on
// default, but a profile that already existed keeps the behaviour it had:
// off, unless the person had already stored an explicit choice. That way an
// update never starts writing transcripts to disk for someone who never asked
// for it, and the setting remains a plain boolean once it has been stored.
function resolveHistoryEnabled({ hadSettingsFile, storedValue }) {
  if (typeof storedValue === 'boolean') return storedValue;
  return hadSettingsFile ? false : true;
}

module.exports = { resolveHistoryEnabled };
