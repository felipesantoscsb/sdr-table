// src/zapi/sender.js

import axios from 'axios';
import { config } from '../../config/index.js';

const zapiClient = axios.create({
  baseURL: config.zapi.baseUrl(),
  headers: {
    'Content-Type': 'application/json',
    'Client-Token': config.zapi.clientToken,
  },
});

/**
 * Calcula delay em ms baseado no tamanho da mensagem.
 * Simula tempo de digitação humana.
 */
function typingDelay(message) {
  const len = message.length;
  if (len <= 80)  return Math.floor(Math.random() * (12000 - 8000) + 8000);   // 8-12s
  if (len <= 200) return Math.floor(Math.random() * (25000 - 15000) + 15000); // 15-25s
  return Math.floor(Math.random() * (45000 - 30000) + 30000);                 // 30-45s
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function sendMessage(phone, message) {
  try {
    const delay = typingDelay(message);
    console.log(`⏳ Aguardando ${Math.round(delay/1000)}s antes de enviar para ${phone}`);
    await sleep(delay);

    const response = await zapiClient.post('/send-text', { phone, message });
    console.log(`✅ Mensagem enviada para ${phone}`);
    return response.data;
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error(`❌ Erro ao enviar para ${phone}:`, detail);
    throw error;
  }
}

export async function notifySDR(leadData, sdrBriefing, suggestedSecondMessage = '') {
  const cleanPhone = (leadData.whatsapp || leadData.whats || '').replace(/\D/g, '');
  const score = leadData.qualificacao?.score ?? leadData.score ?? '?';
  const tier = (leadData.qualificacao?.tier || leadData.temperatura || '').toUpperCase();
  const monitorar = leadData._monitorarDePerto;
  const avisoNatalia = leadData._avisoNatalia;

  const lines = [
    `🎯 *NOVO LEAD ATIVADO*`,
    ``,
    avisoNatalia ? `⚠️ *LEAD DA NATÁLIA KELM*\nPré-consulta deve ser agendada diretamente com a Natália.\n` : '',
    monitorar ? `🔴 *MONITORAR DE PERTO — lead quente*\n` : '',
    `👤 *${leadData.nome}*`,
    `🌡️ Temperatura: ${tier} | Score: ${score}/10`,
    ``,
    `📊 *Briefing da IA:*`,
    sdrBriefing,
    ``,
    `💬 *Sugestão de 2ª mensagem:*`,
    suggestedSecondMessage || '(não gerada)',
    ``,
    `🔗 Abrir conversa: https://wa.me/${cleanPhone}`,
  ].filter(l => l !== '');

  await sendMessage(config.sdr.phone, lines.join('\n'));
}

export async function notifySDRReply(leadData, leadMessage, sdrBriefing) {
  const cleanPhone = (leadData.whatsapp || leadData.whats || '').replace(/\D/g, '');

  const lines = [
    `💬 *ATUALIZAÇÃO DE CONVERSA*`,
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

export async function notifySDRHandoff(leadData, turno) {
  const cleanPhone = (leadData.whatsapp || leadData.whats || '').replace(/\D/g, '');

  const lines = [
    `🟢 *HANDOFF — LEAD PRONTA PARA AGENDAR*`,
    ``,
    `👤 *${leadData.nome}*`,
    `🔗 https://wa.me/${cleanPhone}`,
    ``,
    `🕐 Preferência de turno: *${turno}*`,
    ``,
    `A lead sinalizou interesse em agendar. Assuma a conversa e confirme o horário.`,
  ];

  await sendMessage(config.sdr.phone, lines.join('\n'));
}

export async function notifySDRRedflag(leadData, motivo) {
  const cleanPhone = (leadData.whatsapp || leadData.whats || '').replace(/\D/g, '');

  const lines = [
    `🚨 *RED FLAG — ATENÇÃO IMEDIATA*`,
    ``,
    `👤 *${leadData.nome}*`,
    `🔗 https://wa.me/${cleanPhone}`,
    ``,
    `⚠️ *Motivo:* ${motivo}`,
    ``,
    `O agente parou de responder. Assuma a conversa com cuidado.`,
  ];

  await sendMessage(config.sdr.phone, lines.join('\n'));
}
