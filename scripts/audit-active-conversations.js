import { safeGet, safeKeys } from '../src/redis.js';

function parseJson(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function formatAge(ts) {
  if (!ts) return 'sem lastseen';
  const diffMs = Date.now() - Number(ts);
  if (!Number.isFinite(diffMs)) return 'lastseen invalido';
  const hours = Math.floor(diffMs / 36e5);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const convKeys = await safeKeys('conv:*');
const rows = [];

for (const key of convKeys) {
  const phone = key.replace('conv:', '');
  const conv = parseJson(await safeGet(key));
  if (!conv?.isActiveLead || conv.handedOff) continue;

  const lastSeen = await safeGet(`lastseen:${phone}`);
  const queue = await safeGet(`queue:${phone}`);
  const lead = conv.leadData || {};
  const lastAssistant = [...(conv.messages || [])]
    .reverse()
    .find(message => message.role === 'assistant')?.content || '';

  rows.push({
    phone,
    nome: lead.nome || lead.name || 'sem nome',
    source: lead.source || 'sem source',
    score: lead.qualificacao?.score ?? lead.score ?? '',
    tier: lead.qualificacao?.tier || lead.temperatura || lead.tier || '',
    turnCount: conv.turnCount || 0,
    lastSeenAge: formatAge(lastSeen),
    hasQueue: queue ? 'sim' : 'nao',
    lastAssistant: lastAssistant.replace(/\s+/g, ' ').slice(0, 120),
  });
}

rows.sort((a, b) => a.phone.localeCompare(b.phone));

console.log(`Conversas ativas sem handoff: ${rows.length}`);
console.table(rows);
