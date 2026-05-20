// src/webhook/zapiHandler.js

import { isActiveLead, isHandedOff, setHandedOff, addMessage, getHistory, getLeadData } from '../conversation/store.js';
import { aggregate } from '../conversation/aggregator.js';
import { generateReply, generateHandoffBriefing } from '../ai/anthropic.js';
import { sendMessage, notifySDRHandoff, notifySDRRedflag } from '../zapi/sender.js';

export async function handleZapiMessage(req, res) {
  res.status(200).json({ ok: true });

  try {
    const body = req.body;

    if (body.type !== 'ReceivedCallback') return;

    const phone = body.phone?.replace(/\D/g, '');
    const messageText = body.text?.message || body.text;

    if (!phone || !messageText) return;

    // Karina respondeu manualmente — handoff automático
    if (body.isFromMe) {
      if (isActiveLead(phone) && !isHandedOff(phone)) {
        console.log(`👩 Karina assumiu conversa com ${phone} — handoff automático`);
        setHandedOff(phone);
      }
      return;
    }

    if (!isActiveLead(phone)) {
      console.log(`⏭️  Mensagem ignorada de ${phone} (não é lead ativo)`);
      return;
    }

    if (isHandedOff(phone)) {
      console.log(`⏭️  Mensagem ignorada de ${phone} (handoff ativo)`);
      return;
    }

    console.log(`📨 Mensagem de lead ativo ${phone}`);
    aggregate(phone, messageText, processAggregatedMessages);

  } catch (err) {
    console.error('❌ Erro no handler da Zapi:', err.message);
  }
}

async function processAggregatedMessages(phone, combinedMessage) {
  console.log(`⚡ Processando mensagens de ${phone}`);

  try {
    const history = getHistory(phone);
    const leadData = getLeadData(phone);

    addMessage(phone, 'user', combinedMessage);

    const result = await generateReply(phone, combinedMessage, history, leadData);

    // Red flag
    if (result.redflag) {
      console.log(`🚨 Red flag detectado para ${phone}: ${result.redflagMotivo}`);
      setHandedOff(phone);
      await notifySDRRedflag(leadData, result.redflagMotivo);
      return;
    }

    // Handoff — envia mensagem de espera, gera briefing com histórico e notifica Karina
    if (result.handoff) {
      console.log(`🟢 Handoff ativado para ${phone}`);
      addMessage(phone, 'assistant', result.leadMessage);
      await sendMessage(phone, result.leadMessage);
      setHandedOff(phone);

      const handoffBriefing = await generateHandoffBriefing(
        leadData,
        getHistory(phone),
        result.handoffTurno
      );

      await notifySDRHandoff(leadData, result.handoffTurno, handoffBriefing);
      return;
    }

    // Fluxo normal
    addMessage(phone, 'assistant', result.leadMessage);
    await sendMessage(phone, result.leadMessage);

  } catch (err) {
    console.error(`❌ Erro ao processar resposta para ${phone}:`, err.message);
  }
}
