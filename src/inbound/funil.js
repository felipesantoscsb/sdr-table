// Reporte do funil do inbound para o Hub.
//
// Os estágios até o handoff só existem no Redis daqui e somem. O Hub é quem
// guarda, porque é lá que o relatório mora e é lá que estão os estágios
// seguintes (agendado, convertido), em pipeline_cards.
//
// Fire-and-forget SEMPRE: isto é telemetria. Uma conversa com lead real nunca
// pode quebrar porque o relatório não gravou.
//
// O event_id é determinístico (telefone + etapa), não aleatório. Com id
// aleatório, um reenvio por falha de rede viraria um segundo evento e o funil
// contaria a mesma lead duas vezes. Determinístico, o Hub descarta a repetição
// pelo ON CONFLICT — e é isso que também torna o backfill seguro de rodar
// quantas vezes for preciso.

import axios from 'axios';
import { normalizePhone } from '../conversation/store.js';

const HUB_URL = process.env.HUB_INBOUND_EVENT_URL
  || 'https://crm.tableclinic.com.br/webhook/inbound/event';
const HUB_SECRET = process.env.HUB_WEBHOOK_SECRET || process.env.INTERNAL_WEBHOOK_SECRET;

export function eventIdDe(phone, tipo) {
  return `inb:${normalizePhone(phone)}:${tipo}`;
}

/**
 * Carimba uma etapa no Hub. Nunca lança.
 * tipo: conversa_iniciada | primeira_resposta | qualificada | handoff | desqualificada
 */
export async function registrarEtapa({ phone, tipo, source = null, nome = null, score = null, motivo = null, occurredAt = null }) {
  if (!HUB_SECRET) {
    console.warn('[funil-inbound] HUB_WEBHOOK_SECRET ausente — etapa não reportada');
    return false;
  }
  try {
    await axios.post(HUB_URL, {
      event_id: eventIdDe(phone, tipo),
      phone: normalizePhone(phone),
      tipo, source, nome, score, motivo,
      occurred_at: occurredAt || new Date().toISOString(),
    }, {
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': HUB_SECRET },
      timeout: 8_000,
    });
    return true;
  } catch (err) {
    console.warn(`[funil-inbound] etapa ${tipo} de ${phone} não reportada: ${err.message}`);
    return false;
  }
}

/** Versão que nunca é aguardada pelo chamador. */
export function registrar(dados) {
  registrarEtapa(dados).catch(() => {});
}
