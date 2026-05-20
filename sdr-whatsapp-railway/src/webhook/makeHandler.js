// src/webhook/makeHandler.js
//
// DECISÃO TÉCNICA: Por que um handler separado para o Make?
// → O webhook do Make (que traz leads) e o webhook da Zapi (que traz respostas)
//   têm formatos completamente diferentes. Handlers separados = código limpo.
//
// FLUXO:
// Make → POST /webhook/lead → valida segredo → normaliza dados →
// chama IA → envia mensagem ao lead → notifica SDR → registra lead como ativo

import { activateLead, addMessage } from '../conversation/store.js';
import { generateFirstContact } from '../ai/anthropic.js';
import { sendMessage, notifySDR } from '../zapi/sender.js';

/**
 * Normaliza os dados vindos do Make para um formato consistente interno.
 * Motivo: nomes de campos do Make podem ter espaços, acentos ou capitalização variada.
 */
function normalizeLead(body) {
  return {
    nome:             body['Nome']             || body['nome']             || 'Lead',
    whatsapp:         body['WhatsApp']         || body['whatsapp']         || body['Whatsapp'] || '',
    temperatura:      body['Temperatura']      || body['temperatura']      || 'desconhecida',
    score:            body['Score']            || body['score']            || '0',
    oqueMaisPesa:     body['O que mais pesa']  || body['oqueMaisPesa']     || '',
    historico:        body['Histórico']        || body['historico']        || body['Historico'] || '',
    saude:            body['Saúde']            || body['saude']            || body['Saude'] || '',
    comprometimento:  body['Comprometimento']  || body['comprometimento']  || '',
    maiorDificuldade: body['Maior dificuldade']|| body['maiorDificuldade'] || '',
  };
}

/**
 * Processa webhook de novo lead vindo do Make.
 */
export async function handleMakeLead(req, res) {
  // 1. Validação do segredo — evita que alguém dispare seu webhook aleatoriamente
  const secret = req.headers['x-webhook-secret'] || req.body.secret;
  if (secret !== process.env.WEBHOOK_SECRET) {
    console.warn('⚠️  Tentativa de acesso com segredo inválido');
    return res.status(401).json({ error: 'Não autorizado' });
  }

  // 2. Normaliza os dados
  const leadData = normalizeLead(req.body);

  if (!leadData.whatsapp) {
    return res.status(400).json({ error: 'Campo WhatsApp é obrigatório' });
  }

  // Limpa o número: remove tudo que não for dígito
  const phone = leadData.whatsapp.replace(/\D/g, '');

  console.log(`📥 Novo lead recebido: ${leadData.nome} (${phone})`);

  // 3. Responde ao Make imediatamente — não deixa o Make esperando
  // Motivo: o Make tem timeout curto. Processamos em background.
  res.status(200).json({ received: true, phone });

  // 4. Processamento assíncrono (não bloqueia a resposta ao Make)
  try {
    // Chama IA para gerar mensagem do lead + briefing da SDR
    const { leadMessage, sdrBriefing, suggestedSecondMessage } =
      await generateFirstContact(leadData);

    // Marca este número como lead ativo no sistema
    activateLead(phone, leadData);

    // Registra no histórico: a mensagem que a IA vai enviar
    addMessage(phone, 'assistant', leadMessage);

    // Envia mensagem ao lead
    await sendMessage(phone, leadMessage);

    // Notifica a SDR com briefing + link wa.me + sugestão de 2ª mensagem
    await notifySDR(leadData, sdrBriefing, suggestedSecondMessage);

    console.log(`✅ Lead ${leadData.nome} processado com sucesso`);
  } catch (err) {
    console.error(`❌ Erro ao processar lead ${leadData.nome}:`, err.message);
  }
}
