// src/followup.js

import { safeGet, safeSet, safeDel, safeKeys } from './redis.js';
import { normalizePhone } from './conversation/store.js';
import { sendMessage } from './zapi/sender.js';

const FOLLOWUP_DELAY_MS = 6 * 60 * 60 * 1000; // 6 horas
const TRACK_TTL_SEC     = 7  * 24 * 60 * 60;   // 7 dias
const CHECK_INTERVAL_MS = 60 * 1000;            // verificar a cada 1 min

const BASE_URL = process.env.BASE_URL || 'https://estrutura-table-production.up.railway.app';

export function startFollowUpJob() {
  console.log('⏰ Job de follow-up 6h ativado');
  setInterval(checkFollowUps, CHECK_INTERVAL_MS);
}

async function checkFollowUps() {
  const keys = await safeKeys('lead:*');
  if (!keys.length) return;

  const now = Date.now();

  for (const key of keys) {
    const raw = await safeGet(key);
    if (!raw) continue;

    let lead;
    try { lead = JSON.parse(raw); } catch { continue; }

    const phone = lead.phone || key.replace('lead:', '');
    if (!phone) continue;

    // Só processa leads com 6h+
    if (!lead.timestamp || now - lead.timestamp < FOLLOWUP_DELAY_MS) continue;

    // Já comprou?
    const compra = await safeGet(`compra:${phone}`);
    if (compra) {
      console.log(`🛒 Lead ${lead.nome} (${phone}) já comprou — pulando follow-up`);
      await safeDel(key);
      continue;
    }

    // Já enviou follow-up?
    const jaEnviou = await safeGet(`followup:${phone}`);
    if (jaEnviou) continue;

    await sendFollowUp(lead, phone);
    await safeDel(key); // remove da fila de pendentes
  }
}

async function sendFollowUp(lead, phone) {
  try {
    const uuid = crypto.randomUUID();

    await safeSet(`track:${uuid}`, JSON.stringify({ ...lead, phone }), 'EX', TRACK_TTL_SEC);
    await safeSet(`followup:${phone}`, '1', 'EX', TRACK_TTL_SEC);

    const nome = lead.nome?.split(' ')[0] || 'Oi';
    const link = `${BASE_URL}/track/${uuid}`;

    const msg =
      `Oi ${nome}! 💚 Vi que você conheceu o protocolo da Evelyn mas ainda não deu o próximo passo.\n\n` +
      `Às vezes o protocolo padrão não é o suficiente para o que você precisa — a Karina pode te ajudar a entender qual é o melhor caminho pra você.\n\n` +
      `Quer conversar com ela? 👇\n${link}`;

    await sendMessage(phone, msg, { skipDelay: true });
    console.log(`📤 Follow-up enviado para ${lead.nome} (${phone}) — track: ${uuid}`);
  } catch (err) {
    console.error(`❌ Erro no follow-up de ${phone}:`, err.message);
  }
}
