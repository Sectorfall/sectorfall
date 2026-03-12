export const CHAT_SCOPE = {
  WORLD: 'WORLD',
  SYSTEM: 'SYSTEM',
  FLEET: 'FLEET',
  SYNDICATE: 'SYNDICATE',
  DIRECT: 'DIRECT'
};

export function normalizeCommanderName(name) {
  return (name || '').trim().toUpperCase();
}

// Parses "@NAME message..."  -> { toName, body } or null
export function parseDirectMention(text) {
  const raw = (text || '').trim();
  if (!raw.startsWith('@')) return null;
  const firstSpace = raw.indexOf(' ');
  const tag = firstSpace === -1 ? raw : raw.slice(0, firstSpace);
  const toName = normalizeCommanderName(tag.slice(1));
  const body = firstSpace === -1 ? '' : raw.slice(firstSpace + 1).trim();
  if (!toName) return null;
  return { toName, body };
}