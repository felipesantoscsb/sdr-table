// src/zapi/sender.js
//
// DECISÃO TÉCNICA: Por que abstrair a Zapi num módulo separado?
// → Se um dia trocar Zapi por outra API de WhatsApp (Evolution, WPPConnect...),
//   você muda APENAS este arquivo. O resto do sistema não sabe qual API usa.

import axios from 'axios';
import { config } from '../../config/index.js';

// Cliente axios pré-configurado com headers da Zapi
// Motivo: não precisar repetir os headers em cada chamada
const zapiClient = axios.create({
  baseURL: config.zapi.baseUrl(),
  headers: {
    'Content-Type': 'application/json',
    'Client-Token': config.zapi.clientToken,
  },
});

/**
 * Envia mensagem de texto pelo WhatsApp via Zapi.
 *
 * @param {string} phone - Número no formato 5511999999999 (sem + ou espaços)
 * @param {string} message - Texto a enviar
 */
export async function sendMessage(phone, message) {
  try {
    const response = await zapiClient.post('/send-text', {
      phone,
      message,
    });

    console.log(`✅ Mensagem enviada para ${phone}`);
    return response.data;
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error(`❌ Erro ao enviar para ${phone}:`, detail);
    throw error;
  }
}

/**
 * Envia notificação para a SDR com link wa.me do lead + briefing.
 *
 * @param {Object} leadData - Dados do lead
 * @param {string} sdrBriefing - Análise gerada pela IA
 * @param {string} suggestedSecondMessage - Sugestão de 2ª mensagem (opcional)
 */
export async function notifySDR(leadData, sdrBriefing, suggestedSecondMessage = '') {
  // Limpa o número para o link wa.me (remove tudo que não for dígito)
  const cleanPhone = leadData.whatsapp.replace(/\D/g, '');

  const lines = [
    `🎯 *NOVO LEAD ATIVADO*`,
    ``,
    `👤 *${leadData.nome}*`,
    `🌡️ Temperatura: ${leadData.temperatura} | Score: ${leadData.score}/100`,
    ``,
    `📊 *Briefing da IA:*`,
    sdrBriefing,
    ``,
    `💬 *Sugestão de 2ª mensagem:*`,
    suggestedSecondMessage || '(não gerada)',
    ``,
    `🔗 Abrir conversa: https://wa.me/${cleanPhone}`,
  ];

  await sendMessage(config.sdr.phone, lines.join('\n'));
}

/**
 * Notifica a SDR sobre uma resposta de lead em conversa ativa.
 */
export async function notifySDRReply(leadData, leadMessage, sdrBriefing) {
  const cleanPhone = leadData.whatsapp.replace(/\D/g, '');

  const lines = [
    `💬 *RESPOSTA DE LEAD*`,
    ``,
    `👤 *${leadData.nome}*`,
    `🔗 https://wa.me/${cleanPhone}`,
    ``,
    `🤖 *IA respondeu:*`,
    leadMessage,
    ``,
    `📊 *Situação atual:*`,
    sdrBriefing,
  ];

  await sendMessage(config.sdr.phone, lines.join('\n'));
}
