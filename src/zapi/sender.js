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

function typingDelay(message) {
  const len = message.length;
  if (len <= 80)  return Math.floor(Math.random() * (12000 - 8000) + 8000);
  if (len <= 200) return Math.floor(Math.random() * (25000 - 15000) + 15000);
  return Math.floor(Math.random() * (45000 - 30000) + 30000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function sendMessage(phone, message, options = {}) {
  try {
    if (!options.skipDelay) {
      const delay = typingDelay(message);
      console.log(`⏳ Aguardando ${Math.round(delay/1000)}s antes de enviar para ${phone}`);
      await sleep(delay);
    }

    const response = await zapiClient.post('/send-text', { phone, message });
    console.log(`✅ Mensagem enviada para ${phone}`);
    return response.data;
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error(`❌ Erro ao enviar para ${phone}:`, detail);
    throw error;
  }
}

export async function notifySDR(leadData, sdrBriefing) {
  const cleanPhone = (leadData.whatsapp || leadData.whats || '').replace(/\D/g, '');
  const score = leadData.qualificacao?.score ?? leadData.score ?? '?';
  const tier = (leadData.qualificacao?.tier || leadData.temperatura || '').toUpperCase();
  const monitorar = leadData._monitorarDePerto;
  const avisoNatalia = leadData._avisoNatalia;

  const lines = [
    `🎯 *NOVO LEAD ATIVADO*`,
    ``,
    avisoNatalia ? `⚠️ *LEAD DA NATÁLIA KELM*\nPré-consulta deve ser agendada diretamente com a Natália.\n` : null,
    monitorar ? `🔴 *MONITORAR DE PERTO*\n` : null,
    `👤 *${leadData.nome}*`,
    `🌡️ ${tier} | Score: ${score}/10`,
    ``,
    `📊 *Briefing:*`,
    sdrBriefing,
    ``,
    `🔗 https://wa.me/${cleanPhone}`,
  ].filter(l => l !== null);

  await sendMessage(config.sdr.phone, lines.join('\n'), { skipDelay: true });
}

export async function notifySDRHandoff(leadData, turno, handoffBriefing) {
  const cleanPhone = (leadData.whatsapp || leadData.whats || '').replace(/\D/g, '');
  const score = leadData.qualificacao?.score ?? leadData.score ?? '?';
  const tier = (leadData.qualificacao?.tier || leadData.temperatura || '').toUpperCase();

  const lines = [
    `🟢 *HANDOFF — PRONTA PARA AGENDAR*`,
    ``,
    `👤 *${leadData.nome}* | ${tier} | Score: ${score}/10`,
    `🕐 Turno preferido: *${turno}*`,
    ``,
    `📋 *Resumo da conversa:*`,
    handoffBriefing,
    ``,
    `🔗 https://wa.me/${cleanPhone}`,
  ];

  await sendMessage(config.sdr.phone, lines.join('\n'), { skipDelay: true });
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

  await sendMessage(config.sdr.phone, lines.join('\n'), { skipDelay: true });
}
