// src/webhook/trackHandler.js

import { safeGet, safeSet } from '../redis.js';
import { sendMessage } from '../zapi/sender.js';

const KARINA_PHONE = '5511977130088';
const WHATSAPP_REDIRECT = 'https://wa.me/5511977130088?text=Oi%20Karina%2C%20vi%20que%20voc%C3%AAs%20podem%20me%20ajudar!';

export async function handleTrack(req, res) {
  const { uuid } = req.params;

  const raw = await safeGet(`track:${uuid}`);
  if (!raw) {
    return res.redirect(WHATSAPP_REDIRECT);
  }

  let lead;
  try { lead = JSON.parse(raw); } catch {
    return res.redirect(WHATSAPP_REDIRECT);
  }

  await safeSet(`track_click:${uuid}`, JSON.stringify({ timestamp: Date.now(), phone: lead.phone }), 'EX', 7 * 24 * 60 * 60);

  console.log(`🔗 Track clicado: ${lead.nome} (${lead.phone}) — uuid: ${uuid}`);

  notifyKarina(lead, uuid).catch(err =>
    console.error('❌ Erro ao notificar Karina:', err.message)
  );

  return res.redirect(WHATSAPP_REDIRECT);
}

async function notifyKarina(lead, uuid) {
  // Campos alinhados com o que o quizHandler grava:
  // { nome, whatsapp, perfil, historico, respostas, source, phone }
  const linhas = [
    `🔔 Lead interessada em conversar!`,
    ``,
    `👤 Nome: ${lead.nome || '-'}`,
    `📱 Telefone: ${lead.phone || lead.whatsapp || '-'}`,
    `🎯 Perfil: ${lead.perfil || '-'}`,
    ``,
    `📊 Quiz:`,
    `• Histórico: ${lead.historico || '-'}`,
    `• Perguntas e respostas: ${lead.respostas || '-'}`,
    ``,
    `Ela acabou de clicar para falar com você agora 👆`,
  ];

  await sendMessage(KARINA_PHONE, linhas.join('\n'), { skipDelay: true });
  console.log(`✅ Karina notificada sobre ${lead.nome}`);
}
