import { reemitManualHandoffs } from '../src/manualHandoff/reemit.js';

function hasFlag(name) {
  return process.argv.includes(name);
}

function numberArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const parsed = Number(process.argv[idx + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const dryRun = hasFlag('--dry-run');
const includeEvelynDirect = hasFlag('--include-evelyn-direct');
const limit = numberArg('--limit', 50);

const result = await reemitManualHandoffs({
  dryRun,
  includeEvelynDirect,
  limit,
});

console.log(JSON.stringify({
  sent: result.sent,
  count: result.count,
  leads: result.leads.map(lead => ({
    nome: lead.nome,
    phone: String(lead.phone || '').replace(/\d(?=\d{4})/g, '*'),
    source: lead.source,
    status: lead.status,
  })),
}, null, 2));

process.exit(0);
