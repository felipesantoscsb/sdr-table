import { safeGet, safeSet, safeDel, safeKeys } from './redis.js';
import { sendOfficialTemplate } from './whatsappOfficial/sender.js';
import {
  registrarTemplateWhatsApp,
  verificarElegibilidadeContatoSdr,
  bloqueioDefinitivoSdr,
} from './hub/client.js';
import { normalizePhone, isBlocked } from './conversation/store.js';

const CHECK_INTERVAL_MS = 60 * 1000;
const CADENCE_TTL_SEC = 7 * 24 * 60 * 60;
const LOCK_TTL_SEC = 10 * 60;
// Atraso máximo tolerado para um passo da cadência (cobre noite/fim de semana).
const STALE_MS = Number(process.env.QUIZ_CADENCE_STALE_MS || 18 * 60 * 60 * 1000);

// Cadência oficial ativa para todo novo QuizCompleted. Fica ligada por
// padrão, mas com interruptor: QUIZ_CADENCE_ENABLED=false derruba tudo sem
// precisar de deploy (o job nem sobe e a fila pendente é limpa no boot).
export const QUIZ_CADENCE_ENABLED = process.env.QUIZ_CADENCE_ENABLED !== 'false';
export const QUIZ_CADENCE_VERSION = 'pr_d1_d3_d5_v1';

export const QUIZ_CADENCE_STEPS = [
  {
    key: 'd1',
    delayMs: Number(process.env.QUIZ_CADENCE_D1_DELAY_MS || 24 * 60 * 60 * 1000),
    templateName: 'd1_pr',
    params: (lead) => [firstName(lead.nome)],
  },
  {
    key: 'd3',
    delayMs: Number(process.env.QUIZ_CADENCE_D3_DELAY_MS || 3 * 24 * 60 * 60 * 1000),
    templateName: 'd3_pr',
    params: (lead) => [firstName(lead.nome)],
  },
  {
    key: 'd5',
    delayMs: Number(process.env.QUIZ_CADENCE_D5_DELAY_MS || 5 * 24 * 60 * 60 * 1000),
    templateName: 'd5_pr',
    params: (lead) => [firstName(lead.nome)],
  },
];

const productionDependencies = {
  safeGet,
  safeSet,
  safeDel,
  safeKeys,
  sendOfficialTemplate,
  registrarTemplateWhatsApp,
  verificarElegibilidadeContatoSdr,
  bloqueioDefinitivoSdr,
  isBlocked,
};
let dependencies = { ...productionDependencies };
let isRunning = false;

// Permite QA determinístico sem Redis, Meta ou Hub reais.
export function setQuizCadenceTestDependencies(overrides = {}) {
  dependencies = { ...productionDependencies, ...overrides };
}

export function resetQuizCadenceTestDependencies() {
  dependencies = { ...productionDependencies };
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'você';
}

function quizScore(lead = {}) {
  let score = 50;
  if (lead.lead_event_id) score += 15;
  if (lead.tier === 'hot') score += 20;
  if (lead.tier === 'warm') score += 10;
  if (lead.perfil) score += 10;
  if (lead.respostas && String(lead.respostas).length > 120) score += 10;
  return Math.min(score, 100);
}

function dentroDoHorario() {
  const brasilia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dia = brasilia.getDay();
  const hora = brasilia.getHours();
  const fds = dia === 0 || dia === 6;
  if (fds) return hora >= 8 && hora < 17;
  return hora >= 8 && hora < 21;
}

function pendingKey(phone, stepIndex) {
  return `pending_quiz_cadence:${phone}:${stepIndex}`;
}

async function loadCadence(phone) {
  const raw = await dependencies.safeGet(`quiz_cadence:${phone}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveCadence(phone, cadence) {
  await dependencies.safeSet(`quiz_cadence:${phone}`, JSON.stringify(cadence), 'EX', CADENCE_TTL_SEC);
}

export async function scheduleQuizCadence(phoneRaw, leadData = {}) {
  if (!QUIZ_CADENCE_ENABLED) return null;

  const phone = normalizePhone(phoneRaw || leadData.phone || leadData.whatsapp || '');
  if (!phone) return null;

  // Não cria uma sequência para quem já comprou ou fez opt-out.
  if (await dependencies.safeGet(`compra:${phone}`) || await dependencies.isBlocked(phone)) return null;

  const occurrenceId = String(leadData.lead_event_id || '').trim() || null;
  const existing = await loadCadence(phone);
  if (existing?.version === QUIZ_CADENCE_VERSION) {
    const sameOccurrence = occurrenceId ? existing.occurrence_id === occurrenceId : true;
    if (sameOccurrence) {
      console.log(`↩️  [quiz-cadence] QuizCompleted duplicado ignorado para ${phone}`);
      return existing;
    }
  }

  const lead = {
    ...leadData,
    phone,
    score: leadData.score || quizScore(leadData),
    source: leadData.source || 'quiz',
  };
  const now = Date.now();
  // Todos os passos usam o QuizCompleted como origem, nunca o envio anterior.
  const quizCompletedAt = Number(leadData.timestamp) > 0 ? Number(leadData.timestamp) : now;

  await dependencies.safeDel(`quiz_cadence_cancelled:${phone}`);
  const oldKeys = [
    ...await dependencies.safeKeys(`pending_quiz_cadence:${phone}:*`),
    ...await dependencies.safeKeys(`quiz_cadence_sent:${phone}:*`),
    ...await dependencies.safeKeys(`quiz_cadence_lock:${phone}:*`),
  ];
  for (const key of new Set(oldKeys)) await dependencies.safeDel(key);

  const cadence = {
    version: QUIZ_CADENCE_VERSION,
    occurrence_id: occurrenceId,
    phone,
    lead,
    created_at: now,
    quiz_completed_at: quizCompletedAt,
    status: 'scheduled',
    score: lead.score,
    steps: QUIZ_CADENCE_STEPS.map((step, index) => ({
      index,
      key: step.key,
      templateName: step.templateName,
      fire_at: quizCompletedAt + step.delayMs,
      status: 'pending',
    })),
  };
  await saveCadence(phone, cadence);

  for (let index = 0; index < QUIZ_CADENCE_STEPS.length; index++) {
    await dependencies.safeSet(
      pendingKey(phone, index),
      JSON.stringify({
        version: QUIZ_CADENCE_VERSION,
        occurrence_id: occurrenceId,
        phone,
        stepIndex: index,
        fire_at: quizCompletedAt + QUIZ_CADENCE_STEPS[index].delayMs,
      }),
      'EX',
      CADENCE_TTL_SEC
    );
  }

  console.log(`🧭 [quiz-cadence] D+1/D+3/D+5 agendados para ${lead.nome || 'Lead'} (${phone}) — score ${lead.score}`);
  return cadence;
}

export async function cancelQuizCadence(phoneRaw, reason = 'cancelled') {
  const phone = normalizePhone(phoneRaw || '');
  if (!phone) return;

  await dependencies.safeDel(`quiz_cadence:${phone}`);
  await dependencies.safeDel(`quiz_cadence_cancelled:${phone}`);
  await dependencies.safeSet(`quiz_cadence_cancelled:${phone}`, reason, 'EX', CADENCE_TTL_SEC);

  const keys = await dependencies.safeKeys(`pending_quiz_cadence:${phone}:*`);
  for (const key of keys) await dependencies.safeDel(key);

  console.log(`🛑 [quiz-cadence] Cadência cancelada para ${phone} — ${reason}`);
}

export async function clearPendingQuizCadence() {
  const keys = [
    ...await dependencies.safeKeys('pending_quiz_cadence:*'),
    ...await dependencies.safeKeys('quiz_cadence:*'),
  ];
  for (const key of new Set(keys)) await dependencies.safeDel(key);
  console.log(`🧹 [quiz-cadence] ${new Set(keys).size} chave(s) removida(s)`);
}

export function startQuizCadenceJob() {
  if (!QUIZ_CADENCE_ENABLED) {
    console.log('🛑 Cadência pós-quiz oficial desativada');
    return;
  }
  console.log('⏰ Cadência pós-quiz D+1/D+3/D+5 ativada');
  setInterval(checkQuizCadence, CHECK_INTERVAL_MS);
}

export async function checkQuizCadence() {
  if (isRunning) return;
  isRunning = true;
  try {
    const keys = await dependencies.safeKeys('pending_quiz_cadence:*');
    const now = Date.now();

    for (const key of keys) {
      const raw = await dependencies.safeGet(key);
      if (!raw) continue;

      let pending;
      try { pending = JSON.parse(raw); } catch { continue; }

      // Nada que existia antes da ativação desta versão entra em backfill.
      if (pending.version !== QUIZ_CADENCE_VERSION) {
        await dependencies.safeDel(key);
        continue;
      }
      if (!pending.fire_at || pending.fire_at > now) continue;
      // Pendência vencida há muito (ex.: envio falhando por token expirado):
      // descarta em vez de despejar mensagens fora de contexto quando o
      // envio volta a funcionar.
      if (now - pending.fire_at > STALE_MS) {
        await dependencies.safeDel(key);
        console.warn(`🗑️ [quiz-cadence] pendência vencida há ${Math.round((now - pending.fire_at) / 3600000)}h descartada: ${pending.phone} step ${pending.stepIndex}`);
        continue;
      }
      if (!dentroDoHorario()) continue;

      await fireQuizCadenceStep(pending.phone, pending.stepIndex);
    }
  } finally {
    isRunning = false;
  }
}

export async function fireQuizCadenceStep(phoneRaw, stepIndex) {
  const phone = normalizePhone(phoneRaw || '');
  const step = QUIZ_CADENCE_STEPS[Number(stepIndex)];
  if (!phone || !step) return;

  if (await dependencies.safeGet(`compra:${phone}`)) {
    await cancelQuizCadence(phone, 'purchase');
    return;
  }

  if (await dependencies.safeGet(`quiz_cadence_cancelled:${phone}`)) {
    await dependencies.safeDel(pendingKey(phone, stepIndex));
    return;
  }

  // Número bloqueado (/stop): encerra a cadência inteira, não só este step.
  if (await dependencies.isBlocked(phone)) {
    await cancelQuizCadence(phone, 'blocked');
    console.log(`⛔ [quiz-cadence] cadência cancelada para ${phone} (número bloqueado)`);
    return;
  }

  const lock = await dependencies.safeSet(`quiz_cadence_lock:${phone}:${stepIndex}`, '1', 'EX', LOCK_TTL_SEC, 'NX');
  if (!lock) return;

  try {
    const cadence = await loadCadence(phone);
    if (!cadence?.lead || cadence.version !== QUIZ_CADENCE_VERSION) {
      await dependencies.safeDel(pendingKey(phone, stepIndex));
      return;
    }

    const alreadySent = await dependencies.safeGet(`quiz_cadence_sent:${phone}:${step.key}`);
    if (alreadySent) {
      await dependencies.safeDel(pendingKey(phone, stepIndex));
      return;
    }

    // Mesmo veto definitivo usado pelo SDR: venda/ganho ou paciente no Hub
    // encerra a sequência. Falha temporária do Hub continua fail-open.
    const eligibility = await dependencies.verificarElegibilidadeContatoSdr({
      phone,
      leadData: cadence.lead,
      source: 'quiz-cadence',
      purpose: `quiz_cadence_${step.key}`,
    });
    if (dependencies.bloqueioDefinitivoSdr(eligibility)) {
      await cancelQuizCadence(phone, eligibility.reason);
      return;
    }

    // Fecha a janela entre o primeiro check e a consulta ao Hub.
    if (await dependencies.safeGet(`compra:${phone}`)) {
      await cancelQuizCadence(phone, 'purchase');
      return;
    }

    const params = step.params(cadence.lead);
    const provider = await dependencies.sendOfficialTemplate({
      to: phone,
      templateName: step.templateName,
      params,
    });
    if (!provider) {
      await cancelQuizCadence(phone, 'blocked');
      return;
    }

    await dependencies.registrarTemplateWhatsApp({
      leadData: {
        ...cadence.lead,
        source: cadence.lead.source || 'quiz-cadence',
        tier: cadence.lead.tier || `score_${cadence.score || ''}`,
      },
      phone,
      templateName: step.templateName,
      params,
      provider,
    });

    await dependencies.safeSet(`quiz_cadence_sent:${phone}:${step.key}`, '1', 'EX', CADENCE_TTL_SEC);
    await dependencies.safeDel(pendingKey(phone, stepIndex));

    cadence.steps = (cadence.steps || []).map((item) => (
      Number(item.index) === Number(stepIndex)
        ? { ...item, status: 'sent', sent_at: Date.now() }
        : item
    ));
    cadence.status = cadence.steps.some(item => item.status === 'pending') ? 'scheduled' : 'completed';
    await saveCadence(phone, cadence);

    console.log(`✅ [quiz-cadence] ${step.templateName} enviado para ${phone}`);
  } catch (err) {
    console.error(`❌ [quiz-cadence] Erro no step ${step.key} para ${phone}:`, err.message);
  } finally {
    await dependencies.safeDel(`quiz_cadence_lock:${phone}:${stepIndex}`);
  }
}

export async function handleQuizCadenceCancel(req, res) {
  const secret = req.headers['x-webhook-secret'] || req.body?.secret;
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const phone = normalizePhone(req.body?.phone || req.body?.telefone || req.body?.whatsapp || '');
  if (!phone) return res.status(400).json({ error: 'Telefone obrigatório' });

  await cancelQuizCadence(phone, req.body?.reason || 'external');
  return res.json({ ok: true, phone });
}
