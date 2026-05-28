// src/webhook/quizPreHandler.js
// Recebe dados do quiz via Make e armazena no Redis por 7 dias.
// Aguarda a lead acionar o agente pelo WhatsApp antes de processar.

import { safeSet } from '../redis.js';

const SETE_DIAS_SEGUNDOS = 7 * 24 * 60 * 60;
const PREFIX = 'quizpre:';

export async function handleQuizPre(req, res) {
  const secret = req.headers['x-webhook-secret'] || req.body.secret;
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const body = req.body;

  // Normaliza o número
  const rawPhone = body.whats || body.Telefone || body.telefone || '';
  const phone = rawPhone.replace(/\D/g, '');

  if (!phone) {
    return res.status(400).json({ error: 'Número de WhatsApp obrigatório' });
  }

  const dados = {
    nome:         body.nome || body.Nome || 'Lead',
    whatsapp:     phone,
    source:       body.source || 'quiz_table_clinic',
    profile:      body.profile || '',
    profileName:  body.profileName || '',
    temperatura:  body.qualification?.tier || body.tier || 'warm',
    score:        body.qualification?.score || body.score || 5,
    qualificacao: body.qualification || null,
    historico:    body.qualification?.items || [],
    respostas:    body.respostas || [],
    created_at:   body.created_at || new Date().toISOString(),
  };

  await safeSet(PREFIX + phone, JSON.stringify(dados), 'EX', SETE_DIAS_SEGUNDOS);

  console.log(`📦 Dados do quiz armazenados para ${phone} — expira em 7 dias`);
  res.status(200).json({ received: true, phone });
}

export async function getQuizPreData(phone) {
  const { safeGet } = await import('../redis.js');
  const raw = await safeGet(PREFIX + phone);
  return raw ? JSON.parse(raw) : null;
}
