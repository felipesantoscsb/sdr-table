// src/webhook/zapiHandler.js

import { isActiveLead, isHandedOff, setHandedOff, addMessage, getHistory, getLeadData, getSdrHistory, addSdrMessage } from '../conversation/store.js';
import { aggregate } from '../conversation/aggregator.js';
import { generateReply, generateHandoffBriefing, generateConsultivo } from '../ai/anthropic.js';
import { sendMessage, notifySDRHandoff, notifySDRRedflag } from '../zapi/sender.js';
import { handlePlanoCommand } from '../planos/handler.js';
import { config } from '../../config/index.js';

export async function handleZapiMessage(req, res) {
  res.status(200).json({ ok: true });

  try {
    const body = req.body;
    if (body.type !== 'ReceivedCallback') return;

    const phone = body.phone?.replace(/\D/g, '');
    const messageText = body.text?.message || body.text;

    if (!phone || !messageText) return;

    // Ignora mensagens enviadas por nós mesmos
    if (body.isFromMe) return;

    // Mensagem da Karina para o agente
    if (phone === config.sdr.phone) {
      const trimmed = messageText.trim();

      // Comando de geração de plano
      if (trimmed.toLowerCase().startsWith('/plano')) {
        const input = trimmed.slice(6).trim();
        console.log('📄 Comando /plano recebido');
        await handlePlanoCommand(input);
        return;
      }

      // Modo consultivo
      console.log(`💬 Consulta da Karina`);
      await handleSdrConsultivo(trimmed);
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

async function handleSdrConsultivo(pergunta) {
  try {
    const historico = getSdrHistory();
    addSdrMessage('user', pergunta);
    const resposta = await generateConsultivo(pergunta, historico);
    addSdrMessage('assistant', resposta);
    await sendMessage(config.sdr.phone, resposta, { skipDelay: true });
  } catch (err) {
    console.error('❌ Erro no modo consultivo:', err.message);
  }
}

async function processAggregatedMessages(phone, combinedMessage) {
  console.log(`⚡ Processando mensagens de ${phone}`);

  try {
    const history = getHistory(phone);
    const leadData = getLeadData(phone);

    addMessage(phone, 'user', combinedMessage);

    const result = await generateReply(phone, combinedMessage, history, leadData);

    if (result.redflag) {
      console.log(`🚨 Red flag detectado para ${phone}`);
      setHandedOff(phone);
      await notifySDRRedflag(leadData, result.redflagMotivo);
      return;
    }

    if (result.handoff) {
      console.log(`🟢 Handoff ativado para ${phone}`);
      addMessage(phone, 'assistant', result.leadMessage);
      await sendMessage(phone, result.leadMessage);
      setHandedOff(phone);
      const handoffBriefing = await generateHandoffBriefing(leadData, getHistory(phone), result.handoffTurno);
      await notifySDRHandoff(leadData, result.handoffTurno, handoffBriefing);
      return;
    }

    addMessage(phone, 'assistant', result.leadMessage);
    await sendMessage(phone, result.leadMessage);

  } catch (err) {
    console.error(`❌ Erro ao processar resposta para ${phone}:`, err.message);
  }
}
