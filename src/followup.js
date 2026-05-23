// src/followup.js
// Job que roda a cada hora verificando leads inativas há 3 dias.

import { getInactiveLeads, markFollowUpSent } from './conversation/store.js';
import { sendMessage } from './zapi/sender.js';
import { config } from '../config/index.js';

const TRES_DIAS_MS = 3 * 24 * 60 * 60 * 1000;

export function startFollowUpJob() {
  // Roda imediatamente e depois a cada hora
  checkInactiveLeads();
  setInterval(checkInactiveLeads, 60 * 60 * 1000);
  console.log('⏰ Job de follow-up iniciado (verifica a cada hora)');
}

async function checkInactiveLeads() {
  try {
    const inativas = await getInactiveLeads(TRES_DIAS_MS);

    for (const { phone, leadData } of inativas) {
      const cleanPhone = (leadData?.whatsapp || leadData?.whats || phone).replace(/\D/g, '');
      const nome = leadData?.nome || 'Lead';
      const score = leadData?.qualificacao?.score ?? leadData?.score ?? '?';
      const tier = (leadData?.qualificacao?.tier || leadData?.temperatura || '').toUpperCase();

      const msg = [
        `📭 *LEAD SEM RESPOSTA HÁ 3 DIAS*`,
        ``,
        `👤 *${nome}* | ${tier} | Score: ${score}/10`,
        `🔗 https://wa.me/${cleanPhone}`,
        ``,
        `Revise a conversa para entender o que aconteceu e realinhar a abordagem.`,
      ].join('\n');

      await sendMessage(config.sdr.phone, msg, { skipDelay: true });

      // Notifica backup também
      if (process.env.NUMERO_BACKUP) {
        await sendMessage(process.env.NUMERO_BACKUP, msg, { skipDelay: true });
      }

      // Marca como notificado para não enviar de novo
      await markFollowUpSent(phone);

      console.log(`📭 Follow-up enviado para lead inativa: ${nome} (${phone})`);
    }
  } catch (err) {
    console.error('❌ Erro no job de follow-up:', err.message);
  }
}
