// src/webhook/zapiHandler.js

import { isActiveLead, isHandedOff, setHandedOff, addMessage, getHistory, getLeadData, getSdrHistory, addSdrMessage, incrementTurn, getTurnCount, TURN_LIMIT, enqueueMessage, dequeueMessages, normalizePhone } from '../conversation/store.js';
import { aggregate } from '../conversation/aggregator.js';
import { generateReply, generateHandoffBriefing, generateConsultivo } from '../ai/anthropic.js';
import { sendMessage, notifySDRHandoff, notifySDRRedflag, notifySDRTurnLimit, notifyError } from '../zapi/sender.js';
import { handlePlanoCommand } from '../planos/handler.js';
import { config } from '../../config/index.js';

function dentroDoHorario() {
  const agora = new Date();
  const brasilia = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const diaSemana = brasilia.getDay();
  const hora = brasilia.getHours();
  const fimDeSemana = diaSemana === 0 || diaSemana === 6;
  if (fimDeSemana) return hora >= 8 && hora < 17;
  return hora >= 8 && hora < 21;
}

export async function handleZapiMessage(req, res) {
  res.status(200).json({ ok: true });

  try {
    const body = req.body;
    if (body.type !== 'ReceivedCallback') return;

    const phone = normalizePhone(body.phone || '');
    const messageText = body.text?.message || body.text;

    if (!phone || !messageText) return;
    if (body.isFromMe) return;

    // Mensagem da Karina
    if (phone === normalizePhone(config.sdr.phone)) {
      const trimmed = messageText.trim();
      if (trimmed.toLowerCase().startsWith('/stop')) {
        const targetPhone = normalizePhone(trimmed.slice(5).trim());
        if (targetPhone) {
          await setHandedOff(targetPhone);
          await sendMessage(config.sdr.phone, `✅ Lead ${targetPhone} desativada.`, { skipDelay: true });
        }
        return;
      }
      if (trimmed.toLowerCase().startsWith('/plano')) {
        await handlePlanoCommand(trimmed.slice(6).trim());
        return;
      }
      await handleSdrConsultivo(trimmed);
      return;
    }

    if (!await isActiveLead(phone)) {
      console.log(`⏭️  Mensagem ignorada de ${phone} (não é lead ativo)`);
      return;
    }

    if (await isHandedOff(phone)) {
      console.log(`⏭️  Mensagem ignorada de ${phone} (handoff ativo)`);
      return;
    }

    if (!dentroDoHorario()) {
      console.log(`⏰ Fora do horário — enfileirando mensagem de ${phone}`);
      await enqueueMessage(phone, messageText);
      return;
    }

    console.log(`📨 Mensagem de lead ativo ${phone}`);
    aggregate(phone, messageText, processAggregatedMessages);

  } catch (err) {
    console.error('❌ Erro no handler da Zapi:', err.message);
  }
}

export async function processQueue(phone) {
  const messages = await dequeueMessages(phone);
  if (!messages.length) return;
  const combined = messages.join('\n');
  console.log(`📬 Processando fila de ${phone}: ${messages.length} mensagens`);
  await processAggregatedMessages(phone, combined);
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
    const history = await getHistory(phone);
    const leadData = await getLeadData(phone);

    await addMessage(phone, 'user', combinedMessage);
    await incrementTurn(phone);

    const turns = await getTurnCount(phone);
    console.log(`🔢 Turno ${turns}/${TURN_LIMIT} para ${phone}`);

    if (turns >= TURN_LIMIT) {
      console.log(`🛑 Teto de turnos atingido para ${phone}`);
      await setHandedOff(phone);
      const briefing = await generateHandoffBriefing(leadData, await getHistory(phone), 'não informado');
      await notifySDRTurnLimit(leadData, briefing);
      return;
    }

    const result = await generateReply(phone, combinedMessage, history, leadData);

    if (result.redflag) {
      console.log(`🚨 Red flag detectado para ${phone}`);
      await setHandedOff(phone);
      await notifySDRRedflag(leadData, result.redflagMotivo);
      return;
    }

    if (result.handoff) {
      console.log(`🟢 Handoff ativado para ${phone}`);
      await addMessage(phone, 'assistant', result.leadMessage);
      await sendMessage(phone, result.leadMessage);
      await setHandedOff(phone);
      const handoffBriefing = await generateHandoffBriefing(leadData, await getHistory(phone), result.handoffTurno);
      await notifySDRHandoff(leadData, result.handoffTurno, handoffBriefing);
      return;
    }

    await addMessage(phone, 'assistant', result.leadMessage);
    await sendMessage(phone, result.leadMessage);

  } catch (err) {
    console.error(`❌ Erro ao processar resposta para ${phone}:`, err.message);
    await notifyError(phone, err.message);
  }
}
