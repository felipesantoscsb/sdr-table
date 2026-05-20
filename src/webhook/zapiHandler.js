// src/webhook/zapiHandler.js
//
// DECISÃO TÉCNICA: Por que precisamos de webhook da Zapi?
// → A Zapi envia um POST para nosso servidor toda vez que chega uma mensagem
//   no WhatsApp. Assim sabemos quando o lead respondeu.
//
// REGRA CRÍTICA DE NEGÓCIO:
// Só respondemos leads que vieram pelo Make (isActiveLead = true).
// Contatos diretos são ignorados silenciosamente.
// Motivo: evitar que a IA responda pessoas aleatórias que te mandarem mensagem.

import { isActiveLead, addMessage, getHistory, getLeadData } from '../conversation/store.js';
import { aggregate } from '../conversation/aggregator.js';
import { generateReply } from '../ai/anthropic.js';
import { sendMessage, notifySDRReply } from '../zapi/sender.js';

/**
 * Processa mensagens recebidas via webhook da Zapi.
 * Chamado quando o lead (ou qualquer pessoa) manda mensagem para o seu número.
 */
export async function handleZapiMessage(req, res) {
  // Responde à Zapi imediatamente (ela espera 200 rápido)
  res.status(200).json({ ok: true });

  try {
    const body = req.body;

    // A Zapi envia vários tipos de evento — só nos interessa mensagem de texto recebida
    // "isFromMe: false" = mensagem que chegou (não enviada por nós)
    if (body.isFromMe || body.type !== 'ReceivedCallback') return;

    const phone = body.phone?.replace(/\D/g, '');
    const messageText = body.text?.message || body.text;

    if (!phone || !messageText) return;

    // ─── REGRA CENTRAL ────────────────────────────────────────────────────
    // Ignora se não for um lead ativo (não veio pelo Make)
    if (!isActiveLead(phone)) {
      console.log(`⏭️  Mensagem ignorada de ${phone} (não é lead ativo)`);
      return;
    }
    // ──────────────────────────────────────────────────────────────────────

    console.log(`📨 Mensagem de lead ativo ${phone}: "${messageText.substring(0, 50)}..."`);

    // Agrega mensagens — espera 30s por mais mensagens antes de processar
    aggregate(phone, messageText, processAggregatedMessages);

  } catch (err) {
    console.error('❌ Erro no handler da Zapi:', err.message);
  }
}

/**
 * Chamado pelo aggregator após o timer de 30s vencer.
 * Recebe todas as mensagens do lead agregadas em uma string.
 */
async function processAggregatedMessages(phone, combinedMessage) {
  console.log(`⚡ Processando mensagens agregadas de ${phone}`);

  try {
    const history = getHistory(phone);
    const leadData = getLeadData(phone);

    // Registra a mensagem do lead no histórico
    addMessage(phone, 'user', combinedMessage);

    // Chama IA para gerar resposta contextualizada
    const { leadMessage, sdrBriefing } =
      await generateReply(phone, combinedMessage, history, leadData);

    // Registra a resposta da IA no histórico
    addMessage(phone, 'assistant', leadMessage);

    // Envia resposta ao lead
    await sendMessage(phone, leadMessage);

    // Mantém a SDR informada do andamento da conversa
    await notifySDRReply(leadData, leadMessage, sdrBriefing);

  } catch (err) {
    console.error(`❌ Erro ao processar resposta para ${phone}:`, err.message);
  }
}
