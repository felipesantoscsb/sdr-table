// src/webhook/makeHandler.js

import { activateLead, addMessage } from '../conversation/store.js';
import { generateFirstContact } from '../ai/anthropic.js';
import { sendMessage, notifySDR } from '../zapi/sender.js';

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

export async function handleMakeLead(req, res) {
  const secret = req.headers['x-webhook-secret'] || req.body.secret;
  if (secret !== process.env.WEBHOOK_SECRET) {
    console.warn('Tentativa de acesso com segredo inválido');
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const leadData = normalizeLead(req.body);
  const phone = (leadData.whatsapp || leadData.whats).replace(/\D/g, '');

  if (!phone) {
    return res.status(400).json({ error: 'Campo WhatsApp é obrigatório' });
  }

  console.log(`📥 Novo lead recebido: ${leadData.nome} (${phone})`);
  res.status(200).json({ received: true, phone });

  try {
    const result = await generateFirstContact(leadData);

    leadData._monitorarDePerto = result.orientacao?.monitorarDePerto || false;
    leadData._avisoNatalia = result.avisoNatalia || false;

    activateLead(phone, leadData);
    addMessage(phone, 'assistant', result.leadMessage);

    await sendMessage(phone, result.leadMessage);
    await notifySDR(leadData, result.sdrBriefing);

    console.log(`✅ Lead ${leadData.nome} processado`);
  } catch (err) {
    console.error(`❌ Erro ao processar lead ${leadData.nome}:`, err.message);
  }
}
