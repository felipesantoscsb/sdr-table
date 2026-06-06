// src/followup.js
//
// Job que roda a cada 1 min e processa follow-up 6h para leads do quiz.
// Varre keys "quiz:{phone}" no Redis — NÃO toca em "lead:{phone}" (formulário).

import { safeGet, safeSet, safeDel, safeKeys } from './redis.js';
import { sendMessage } from './zapi/sender.js';
import { generateFirstContact } from './ai/anthropic.js';
import { activateLead, addMessage, enqueueMessage } from './conversation/store.js';

const FOLLOWUP_DELAY_MS  = 6 * 60 * 60 * 1000; // 6 horas
const TRACK_TTL_SEC      = 7  * 24 * 60 * 60;   // 7 dias
const PENDING_TTL_SEC    = 7  * 24 * 60 * 60;   // 7 dias
const CHECK_INTERVAL_MS  = 60 * 1000;            // verificar a cada 1 min

const BASE_URL = process.env.BASE_URL || 'https://estrutura-table-production.up.railway.app';

// Horário comercial (America/Sao_Paulo): seg–sex 8h–21h, sáb–dom 8h–17h
export function dentroDoHorario() {
  const brasilia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dia = brasilia.getDay();
  const hora = brasilia.getHours();
  const fds = dia === 0 || dia === 6;
  if (fds) return hora >= 8 && hora < 17;
  return hora >= 8 && hora < 21;
}

export function startFollowUpJob() {
  console.log('⏰ Job de follow-up 6h ativado');
  setInterval(checkFollowUps, CHECK_INTERVAL_MS);
}

// Evita ticks sobrepostos do cron (não-reentrante)
let isRunning = false;

async function checkFollowUps() {
  if (isRunning) return;
  isRunning = true;
  try {
    const keys = await safeKeys('quiz:*');
    if (!keys.length) return;

    const now = Date.now();

    for (const key of keys) {
      const raw = await safeGet(key);
      if (!raw) continue;

      let lead;
      try { lead = JSON.parse(raw); } catch { continue; }

      const phone = lead.phone || key.replace('quiz:', '');
      if (!phone) continue;

      // Só processa leads com 6h+
      if (!lead.timestamp || now - lead.timestamp < FOLLOWUP_DELAY_MS) continue;

      // Já comprou?
      const compra = await safeGet(`compra:${phone}`);
      if (compra) {
        console.log(`🛒 [quiz] Lead ${lead.nome} (${phone}) já comprou — cancelando follow-up`);
        await safeDel(key);
        await safeDel(`pending_followup:${phone}`);
        continue;
      }

      // Já enviou follow-up?
      const jaEnviou = await safeGet(`followup:${phone}`);
      if (jaEnviou) {
        await safeDel(`pending_followup:${phone}`);
        continue;
      }

      // Fora do horário comercial? Mantém na fila (quiz:* persiste) e
      // o cron reprocessa no próximo horário válido — nunca de madrugada.
      if (!dentroDoHorario()) continue;

      await sendFollowUp(lead, phone);
      await safeDel(key); // remove da fila após processar
    }
  } finally {
    isRunning = false;
  }
}

/**
 * Envia o follow-up imediatamente.
 * Chamado pelo cron e pela recovery de redeploy.
 */
export async function fireFollowUp(lead, phone) {
  // Revalida o guard no MOMENTO do disparo (não só no boot da recovery)
  if (await safeGet(`followup:${phone}`)) return;
  await sendFollowUp(lead, phone);
}

async function sendFollowUp(lead, phone) {
  // ── Guards rápidos ──────────────────────────────────────────────────────────
  if (await safeGet(`compra:${phone}`)) {
    console.log(`🛒 [quiz] ${phone} já comprou — follow-up cancelado`);
    return;
  }
  if (await safeGet(`followup:${phone}`)) {
    console.log(`↩️  [quiz] follow-up de ${phone} já disparado — ignorando`);
    return;
  }

  // 1. Lock atômico ANTES do trabalho lento (substitui o set tardio).
  //    ioredis: SET key '1' EX 86400 NX → retorna 'OK' se gravou, null se já existia.
  //    (equivale ao { NX: true, EX: 86400 } do node-redis)
  const acquired = await safeSet(`followup:${phone}`, '1', 'EX', 86400, 'NX');
  if (!acquired) return;

  // 2. Lock de execução com TTL curto (segunda camada contra concorrência)
  const processing = await safeSet(`followup_processing:${phone}`, '1', 'EX', 30, 'NX');
  if (!processing) return;

  try {
    // Monta leadData compatível com generateFirstContact (mesmo formato do makeHandler)
    const leadData = {
      nome:        lead.nome || 'você',
      phone,
      whatsapp:    lead.whatsapp || phone,
      whats:       lead.whatsapp || phone,
      qualificacao: lead.perfil || lead.profileName || null,
      perfil:      lead.perfil || lead.profileName || '',
      historico:   lead.historico || '',
      dores:       lead.respostas || '',
      source:      lead.source || 'quiz-followup-6h',
    };

    const result = await generateFirstContact(leadData);

    leadData._monitorarDePerto = result.orientacao?.monitorarDePerto || false;
    leadData._avisoNatalia = result.avisoNatalia || false;

    // Ativa o agente SDR para esta lead (conv:{phone})
    await activateLead(phone, leadData);
    await addMessage(phone, 'assistant', result.leadMessage);

    if (dentroDoHorario()) {
      await sendMessage(phone, result.leadMessage);
    } else {
      // Mesmo padrão do makeHandler: enfileira a 1ª mensagem para a abertura
      await enqueueMessage(phone, `__PRIMEIRA_MENSAGEM__${result.leadMessage}`);
    }

    await safeDel(`pending_followup:${phone}`);
    console.log(`🤝 [quiz] Agente SDR iniciado via follow-up 6h para ${leadData.nome} (${phone})`);
  } catch (err) {
    console.error(`❌ [quiz] Erro no follow-up de ${phone}:`, err.message);
  } finally {
    // Garante limpeza do lock de execução mesmo em erro
    await safeDel(`followup_processing:${phone}`);
  }
}

/**
 * Salva pending_followup:{phone} no Redis.
 * Chamado pelo quizHandler ao receber um lead.
 */
export async function savePendingFollowup(phone, leadData) {
  const fire_at = (leadData.timestamp || Date.now()) + FOLLOWUP_DELAY_MS;
  await safeSet(
    `pending_followup:${phone}`,
    JSON.stringify({ phone, leadData, scheduled_at: Date.now(), fire_at }),
    'EX', PENDING_TTL_SEC
  );
}
