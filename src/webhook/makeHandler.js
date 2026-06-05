// src/webhook/makeHandler.js

import { activateLead, addMessage, enqueueMessage, normalizePhone } from '../conversation/store.js';
import { generateFirstContact } from '../ai/anthropic.js';
import { sendMessage, notifySDR } from '../zapi/sender.js';
import { safeSet } from '../redis.js';

function dentroDoHorario() {
  const agora = new Date();
  const brasilia = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const diaSemana = brasilia.getDay();
  const hora = brasilia.getHours();
  const fimDeSemana = diaSemana === 0 || diaSemana === 6;
  if (fimDeSemana) return hora >= 8 && hora < 17;
  return hora >= 8 && hora < 21;
}

function normalizeLead(body) {
  return {
    nome:             body['Nome']              || body['nome']             || 'Lead',
    whatsapp:         body['WhatsApp']          || body['whatsapp']         || body['Whatsapp'] || body['whats'] || '',
    whats:            body['WhatsApp']          || body['whatsapp']         || body['Whatsapp'] || body['whats'] || '',
    temperatura:      body['Temperatura']       || body['temperatura']      || body['qualificacao']?.tier || 'desconhecida',
    score:            body['Score']             || body['score']            || body['qualificacao']?.score || '0',
    qualificacao:     body['qualificacao']      || null,
    oqueMaisPesa:     body['O que mais pesa']   || body['oqueMaisPesa']     || body['dores'] || '',
    dores:            body['dores']             || body['O que mais pesa']  || '',
    historico:        body['Histórico']         || body['historico']        || body['Historico'] || '',
    saude:            body['Saúde']             || body['saude']            || body['Saude'] || '',
    comprometimento:  body['Comprometimento']   || body['comprometimento']  || '',
    maiorDificuldade: body['Maior dificuldade'] || body['maiorDificuldade'] || body['dificuldade'] || '',
    dificuldade:      body['dificuldade']       || body['Maior dificuldade']|| '',
    source:           body['source']            || body['Source']           || '',
  };
}

async function processLead(leadData, phone, res) {
  try {
    const result = await generateFirstContact(leadData);

    leadData._monitorarDePerto = result.orientacao?.monitorarDePerto || false;
    leadData._avisoNatalia = result.avisoNatalia || false;

    await activateLead(phone, leadData);
    await addMessage(phone, 'assistant', result.leadMessage);

    if (!dentroDoHorario()) {
      console.log(`⏰ Lead ${leadData.nome} fora do horário — mensagem enfileirada`);
      await enqueueMessage(phone, `__PRIMEIRA_MENSAGEM__${result.leadMessage}`);
      await notifySDR(leadData, result.sdrBriefing);
      return;
    }

    await sendMessage(phone, result.leadMessage);
    await notifySDR(leadData, result.sdrBriefing);

    console.log(`✅ Lead ${leadData.nome} processado`);
  } catch (err) {
    console.error(`❌ Erro ao processar lead ${leadData.nome}:`, err.message);
  }
}

function authWebhook(req, res) {
  const secret = req.headers['x-webhook-secret'] || req.body.secret;
  if (secret !== process.env.WEBHOOK_SECRET) {
    console.warn('Tentativa de acesso com segredo inválido');
    res.status(401).json({ error: 'Não autorizado' });
    return false;
  }
  return true;
}

export async function handleMakeLead(req, res) {
  if (!authWebhook(req, res)) return;

  const leadData = normalizeLead(req.body);
  const phone = normalizePhone(leadData.whatsapp || leadData.whats);

  if (!phone) {
    return res.status(400).json({ error: 'Campo WhatsApp é obrigatório' });
  }

  console.log(`📥 Novo lead recebido: ${leadData.nome} (${phone})`);
  res.status(200).json({ received: true, phone });

  await processLead(leadData, phone);
}

export async function handleQuizLead(req, res) {
  if (!authWebhook(req, res)) return;

  const leadData = normalizeLead(req.body);
  const phone = normalizePhone(leadData.whatsapp || leadData.whats);

  if (!phone) {
    return res.status(400).json({ error: 'Campo WhatsApp é obrigatório' });
  }

  const entry = { ...leadData, phone, timestamp: Date.now() };
  await safeSet(`lead:${phone}`, JSON.stringify(entry), 'EX', 7 * 24 * 60 * 60);

  console.log(`📥 Lead quiz recebido: ${leadData.nome} (${phone})`);
  res.status(200).json({ received: true, phone });

  await processLead(leadData, phone);
}
