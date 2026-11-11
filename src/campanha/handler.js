// src/campanha/handler.js
// Lado inbound da campanha sazonal no sdr-table.
//
// O Hub enviava as mensagens da campanha e registrava o telefone aqui. Esse
// envio saiu em 11/11/2026 (era disparo frio a lead pela Z-API do número
// comercial), e o registro com ele.
//
// O que resta é a RESPOSTA: quando um participante registrado antes do corte
// escreve, o /webhook/zapi roteia para handleCampanhaReply, que detecta
// intenção positiva, avisa o Hub (move card + tag + conta vaga) e gera o
// handoff para a Karina. A janela do registro é de 21 dias.

import { safeGet, safeDel } from '../redis.js';
import { normalizePhone } from '../conversation/store.js';
import { classifyCampaignIntent } from '../ai/anthropic.js';
import { notificarRespostaCampanha } from '../hub/campanha.js';
import { notifyKarinaCampanhaHandoff, notifyKarinaCampanhaResposta } from '../zapi/sender.js';

const PREFIX = 'campanha:';

function key(phone) {
  return PREFIX + normalizePhone(phone);
}

export async function getParticipant(phone) {
  const raw = await safeGet(key(phone));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function clearParticipant(phone) {
  await safeDel(key(phone));
}

// O registro de participante (/webhook/campanha-registro) saiu em 11/11/2026
// com o worker de campanha sazonal do Hub, que era quem chamava. A leitura e a
// limpeza continuam: participante registrado antes do corte ainda tem 21 dias
// de janela para responder, e a resposta precisa ser roteada.
// Processa a resposta de um participante de campanha. Retorna true se a mensagem
// foi tratada como campanha (e o caller deve encerrar), false caso contrário.
export async function handleCampanhaReply(phone, text, participant) {
  try {
    const { positive, source } = await classifyCampaignIntent(text);
    console.log(`[campanha] resposta de ${phone} → positive=${positive} (${source})`);

    if (!positive) {
      // Não é positivo: não move card. Avisa a Karina de leve (nada se perde) e
      // mantém o registro — uma futura mensagem positiva ainda será tratada.
      await notifyKarinaCampanhaResposta(participant, text, { positive: false });
      return true;
    }

    // Positivo → interrompe imediatamente qualquer automação para este número.
    await clearParticipant(phone);

    let hubResult = null;
    try {
      hubResult = await notificarRespostaCampanha({
        campaignSlug: participant.campaignSlug,
        phone,
        nome: participant.nome,
        leadId: participant.leadId,
        cardId: participant.cardId,
        responseText: text,
      });
    } catch (err) {
      console.error('[campanha] callback ao Hub falhou:', err.message);
    }

    const closed = hubResult?.closed === true;
    await notifyKarinaCampanhaHandoff(participant, text, { closed, hubResult });
    return true;
  } catch (err) {
    console.error('[campanha] erro ao processar resposta:', err.message);
    return true; // tratado como campanha mesmo em erro — evita cair no fluxo do agente
  }
}
