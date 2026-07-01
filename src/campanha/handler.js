// src/campanha/handler.js
// Lado inbound da campanha sazonal no sdr-table.
//
// O Hub envia as mensagens da campanha e, a cada envio, registra o telefone
// aqui (/webhook/campanha-registro). Quando o lead responde, o /webhook/zapi
// roteia para handleCampanhaReply: detecta intenção positiva, interrompe a
// automação, avisa o Hub (move card + tag + conta vaga) e gera o handoff para
// a Karina. Esses leads NÃO são "leads ativos" do agente — fluxo isolado.

import { safeGet, safeSet, safeDel } from '../redis.js';
import { normalizePhone } from '../conversation/store.js';
import { classifyCampaignIntent } from '../ai/anthropic.js';
import { notificarRespostaCampanha } from '../hub/campanha.js';
import { notifyKarinaCampanhaHandoff, notifyKarinaCampanhaResposta } from '../zapi/sender.js';

const PREFIX = 'campanha:';
const TTL = 21 * 24 * 60 * 60; // 21 dias — cobre a janela da campanha + respostas tardias

function key(phone) {
  return PREFIX + normalizePhone(phone);
}

export async function registerParticipant(phone, data) {
  await safeSet(key(phone), JSON.stringify(data), 'EX', TTL);
}

export async function getParticipant(phone) {
  const raw = await safeGet(key(phone));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function clearParticipant(phone) {
  await safeDel(key(phone));
}

// Webhook chamado pelo Hub no momento do envio. Autentica pelo segredo interno
// compartilhado (mesmo dos demais webhooks internos Hub↔sdr).
export async function handleCampanhaRegistro(req, res) {
  const expected = process.env.HUB_WEBHOOK_SECRET || process.env.INTERNAL_WEBHOOK_SECRET;
  const received = req.headers['x-webhook-secret'] || req.body?.secret;
  if (!expected || received !== expected) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  const phone = normalizePhone(req.body?.phone || req.body?.telefone || '');
  if (!phone) return res.status(400).json({ error: 'phone obrigatório' });

  await registerParticipant(phone, {
    campaignSlug: req.body.campaign_slug || null,
    nome: req.body.nome || null,
    leadId: req.body.lead_id || null,
    cardId: req.body.card_id || null,
    registeredAt: Date.now(),
  });
  console.log(`[campanha] participante registrado: ${phone} (${req.body.nome || 's/ nome'})`);
  return res.json({ ok: true });
}

// Processa a resposta de um participante de campanha. Retorna true se a mensagem
// foi tratada como campanha (e o caller deve encerrar), false caso contrário.
export async function handleCampanhaReply(phone, text, participant) {
  try {
    const { positive, source } = await classifyCampaignIntent(text);
    console.log(`[campanha] resposta de ${phone} → positive=${positive} (${source})`);

    if (!positive) {
      // Não é positivo: não move card. Avisa a Karina de leve (nada se perde) e
      // mantém o registro — uma futura mensagem positiva ainda será tratada.
      await notifyKarinaCampanhaResposta(participant, text, { positive: false });
      return true;
    }

    // Positivo → interrompe imediatamente qualquer automação para este número.
    await clearParticipant(phone);

    let hubResult = null;
    try {
      hubResult = await notificarRespostaCampanha({
        campaignSlug: participant.campaignSlug,
        phone,
        nome: participant.nome,
        leadId: participant.leadId,
        cardId: participant.cardId,
        responseText: text,
      });
    } catch (err) {
      console.error('[campanha] callback ao Hub falhou:', err.message);
    }

    const closed = hubResult?.closed === true;
    await notifyKarinaCampanhaHandoff(participant, text, { closed, hubResult });
    return true;
  } catch (err) {
    console.error('[campanha] erro ao processar resposta:', err.message);
    return true; // tratado como campanha mesmo em erro — evita cair no fluxo do agente
  }
}
