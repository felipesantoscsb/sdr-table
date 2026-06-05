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
  return {
    nome:             body['Nome']              || body['nome']             || 'Lead',
    whatsapp:         body['WhatsApp']          || body['whatsapp']         || body['Whatsapp'] || body['whats'] || '',
    temperatura:      body['Temperatura']       || body['temperatura']      || body['qualificacao']?.tier || 'desconhecida',
    score:            body['Score']             || body['score']            || body['qualificacao']?.score || '0',
    qualificacao:     body['qualificacao']      || null,
    perfil:           body['perfil']            || body['profile']          || body['qualificacao']?.tier || '',
    oqueMaisPesa:     body['O que mais pesa']   || body['oqueMaisPesa']     || body['dores'] || '',
    historico:        body['Histórico']         || body['historico']        || body['Historico'] || '',
    saude:            body['Saúde']             || body['saude']            || body['Saude'] || '',
    comprometimento:  body['Comprometimento']   || body['comprometimento']  || '',
    maiorDificuldade: body['Maior dificuldade'] || body['maiorDificuldade'] || body['dificuldade'] || '',
    respostas:        body['respostas']         || [],
    source:           body['source']            || body['Source']           || 'quiz',
  };
}

const QUIZ_TTL_SEC = 7 * 24 * 60 * 60; // 7 dias

export async function handleQuizLead(req, res) {
  const secret = req.headers['x-webhook-secret'] || req.body?.secret;
  if (secret !== process.env.WEBHOOK_SECRET) {
    console.warn('⚠️ /webhook/quiz: segredo inválido');
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const leadData = normalizeLead(req.body || {});
  const phone = normalizePhone(leadData.whatsapp);

  if (!phone) {
    return res.status(400).json({ error: 'Campo WhatsApp é obrigatório' });
  }

  // Salva com namespace separado "quiz:" (NÃO interfere em "lead:")
  const entry = { ...leadData, phone, timestamp: Date.now() };
  await safeSet(`quiz:${phone}`, JSON.stringify(entry), 'EX', QUIZ_TTL_SEC);

  // Registra pending_followup para sobreviver a redeploys
  await savePendingFollowup(phone, entry);

  console.log(`📥 [quiz] Lead recebido: ${leadData.nome} (${phone})`);

  // Responde imediatamente — processamento é async
  res.status(200).json({ received: true, phone });

  // Dispara dossiê personalizado em 15 min (sem ativar o agente SDR)
  // scheduleDisparo persiste pending_dossie no Redis
  await scheduleDisparo({
    nome:      leadData.nome,
    phone,
    perfil:    leadData.perfil || leadData.temperatura,
    historico: leadData.historico,
    respostas: leadData.respostas,
    source:    leadData.source,
  });
}
