// src/hub/client.js
// Cliente do Hub CRM (hub-tableclinic). No handoff do agente SDR para agendar
// pré-consulta, migra o card da lead do funil 'captacao' para 'pre_consulta'
// na etapa "A Agendar" — mesmo processo do Protocolo Raiz.

import axios from 'axios';

const HUB_URL = process.env.HUB_HANDOFF_URL
  || 'https://crm.tableclinic.com.br/webhook/handoff-agendamento';
const HUB_SECRET = process.env.HUB_WEBHOOK_SECRET || process.env.INTERNAL_WEBHOOK_SECRET;

const retryDelays = [0, 1500, 4000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Migra o card da lead para pré-consulta / "A Agendar" no Hub, com todos os
// dados do atendimento nas observações. Fire-and-forget no chamador: nunca
// deve quebrar o handoff para a Karina.
export async function migrarParaPreConsulta({ leadData = {}, phone, turno, briefing }) {
  if (!HUB_SECRET) {
    console.warn('[hub] HUB_WEBHOOK_SECRET não configurado — migração de card ignorada');
    return null;
  }

  const payload = {
    nome:             leadData.nome || leadData.name || 'Lead',
    telefone:         phone,
    temperatura:      leadData.temperatura,
    score:            leadData.score,
    oqueMaisPesa:     leadData.oqueMaisPesa,
    dores:            leadData.dores,
    maiorDificuldade: leadData.maiorDificuldade,
    dificuldade:      leadData.dificuldade,
    historico:        leadData.historico,
    saude:            leadData.saude,
    comprometimento:  leadData.comprometimento,
    source:           leadData.source || 'captacao_sdr',
    turno:            turno || null,
    briefing:         briefing || null,
    created_at:       new Date().toISOString(),
  };

  let lastError;
  for (let attempt = 0; attempt < retryDelays.length; attempt++) {
    if (retryDelays[attempt]) await sleep(retryDelays[attempt]);
    try {
      const res = await axios.post(HUB_URL, payload, {
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': HUB_SECRET },
        timeout: 12_000,
      });
      console.log(`[hub] card migrado p/ pré-consulta — ${payload.nome} (${phone}) card ${res.data?.card_id}`);
      return res.data;
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      console.warn(`[hub] tentativa ${attempt + 1} falhou${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    }
  }
  throw lastError;
}
