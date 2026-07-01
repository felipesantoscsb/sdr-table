// src/hub/campanha.js
// Avisa o Hub que um lead respondeu positivamente à campanha sazonal. O Hub
// move o card para a etapa da campanha, tagueia, conta a vaga e — ao preencher
// todas — encerra a campanha. Retorna { closed, slots_full } para que o sdr
// decida entre handoff normal e "aviso de encerramento" para a Karina.

import axios from 'axios';

const HUB_CAMPANHA_URL = process.env.HUB_CAMPANHA_URL
  || 'https://crm.tableclinic.com.br/webhook/campanha-resposta';
const HUB_SECRET = process.env.HUB_WEBHOOK_SECRET || process.env.INTERNAL_WEBHOOK_SECRET;

const retryDelays = [0, 1500, 4000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function notificarRespostaCampanha({ campaignSlug, phone, nome, leadId, cardId, responseText }) {
  if (!HUB_SECRET) {
    console.warn('[hub/campanha] HUB_WEBHOOK_SECRET ausente — callback ignorado');
    return null;
  }

  const payload = {
    campaign_slug: campaignSlug,
    telefone: phone,
    nome: nome || null,
    lead_id: leadId || null,
    card_id: cardId || null,
    response_text: responseText || null,
  };

  let lastError;
  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    if (retryDelays[attempt]) await sleep(retryDelays[attempt]);
    try {
      const res = await axios.post(HUB_CAMPANHA_URL, payload, {
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': HUB_SECRET },
        timeout: 12_000,
      });
      console.log(`[hub/campanha] resposta registrada — ${nome || phone} (closed=${res.data?.closed})`);
      return res.data; // { ok, closed, slots_full, ... }
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      console.warn(`[hub/campanha] tentativa ${attempt + 1} falhou${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    }
  }
  throw lastError;
}
