// src/webhook/quizHandler.js
//
// Recebe leads EXCLUSIVAMENTE de recuperação pós-quiz (aquisicao-table).
// NÃO ativa o agente SDR — apenas salva dados, dispara dossiê 15min
// e agenda follow-up 6h via job em followup.js.

import { safeSet } from '../redis.js';
import { normalizePhone } from '../conversation/store.js';
import { scheduleDisparo } from '../disparos/handler.js';
import { savePendingFollowup } from '../followup.js';

function normalizeLead(body) {
  // "Perguntas e respostas" vem como string formatada do aquisicao-table:
  // "pergunta1: resposta1, pergunta2: resposta2, ..."
  const perguntasRespostas = body['Perguntas e respostas'] || body['perguntas_e_respostas'] || '';

  // respostas como array (fallback para payloads antigos ou outros clientes)
  const respostasArray = Array.isArray(body['respostas']) ? body['respostas'] : [];

  // usa a string formatada se disponível, senão converte o array para string
  const respostas = perguntasRespostas
    || respostasArray.map(r => `${r.pergunta}: ${r.resposta}`).join(', ')
    || '';

  return {
    nome:             body['nome']           || body['Nome']      || 'Lead',
    whatsapp:         body['whatsapp']       || body['WhatsApp']  || body['Whatsapp'] || body['whats'] || '',
    perfil:           body['perfil']         || body['profile']   || body['profileName'] || body['qualificacao']?.tier || '',
    historico:        body['historico']      || body['Histórico'] || body['Historico'] || '',
    respostas,
    source:           body['source']         || body['Source']    || 'quiz',
    lead_event_id:    body['lead_event_id']  || body['lid']       || null,
    tier:             body['tier']           || null, // hot/warm/cold
  };
}

const QUIZ_TTL_SEC = 7 * 24 * 60 * 60; // 7 dias

export async function handleQuizLead(req, res) {
  const secret = req.headers['x-webhook-secret'] || req.body?.secret;
  if (secret !== process.env.WEBHOOK_SECRET) {
    console.warn('⚠️ /webhook/quiz: segredo inválido');
    return res.status(401).json({ error: 'Não autorizado' });
  }

  // Log completo do payload recebido para debug
  console.log('[quiz] Payload recebido:', JSON.stringify(req.body, null, 2));

  const leadData = normalizeLead(req.body || {});
  const phone = normalizePhone(leadData.whatsapp);

  if (!phone) {
    return res.status(400).json({ error: 'Campo WhatsApp é obrigatório' });
  }

  console.log(`📥 [quiz] Lead mapeado:
  Nome:       ${leadData.nome}
  Phone:      ${phone}
  Perfil:     ${leadData.perfil}
  Histórico:  ${leadData.historico || 'vazio'}
  Respostas:  ${leadData.respostas ? `"${String(leadData.respostas).slice(0, 100)}..."` : 'vazio'}
  Source:     ${leadData.source}`);

  // Salva com namespace separado "quiz:" (NÃO interfere em "lead:")
  const entry = { ...leadData, phone, timestamp: Date.now() };
  await safeSet(`quiz:${phone}`, JSON.stringify(entry), 'EX', QUIZ_TTL_SEC);

  // Registra pending_followup para sobreviver a redeploys
  await savePendingFollowup(phone, entry);

  // Responde imediatamente — processamento é async
  res.status(200).json({ received: true, phone });

  // Dispara dossiê personalizado em 15 min (sem ativar o agente SDR)
  await scheduleDisparo({
    nome:           leadData.nome,
    phone,
    perfil:         leadData.perfil,
    historico:      leadData.historico,
    respostas:      leadData.respostas,
    source:         leadData.source,
    lead_event_id:  leadData.lead_event_id,
    tier:           leadData.tier,
  });
}
