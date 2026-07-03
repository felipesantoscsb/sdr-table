// src/webhook/makeHandler.js
// Processa leads do formulário Make → ativa o agente SDR.

import { activateLead, addMessage, enqueueMessage, normalizePhone } from '../conversation/store.js';
import { generateFirstContact } from '../ai/anthropic.js';
import { sendMessage, notifySDR } from '../zapi/sender.js';
import { sendOfficialTemplate } from '../whatsappOfficial/sender.js';

function dentroDoHorario() {
  const agora = new Date();
  const brasilia = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const diaSemana = brasilia.getDay();
  const hora = brasilia.getHours();
  const fimDeSemana = diaSemana === 0 || diaSemana === 6;
  if (fimDeSemana) return hora >= 8 && hora < 17;
  return hora >= 8 && hora < 21;
}

function normalizeLead(body) {
  return {
    nome:             body['Nome']              || body['nome']             || 'Lead',
    whatsapp:         body['WhatsApp']          || body['whatsapp']         || body['Whatsapp'] || body['whats'] || '',
    whats:            body['WhatsApp']          || body['whatsapp']         || body['Whatsapp'] || body['whats'] || '',
    temperatura:      body['Temperatura']       || body['temperatura']      || body['qualificacao']?.tier || 'desconhecida',
    score:            body['Score']             || body['score']            || body['qualificacao']?.score || '0',
    qualificacao:     body['qualificacao']      || null,
    oqueMaisPesa:     body['O que mais pesa']   || body['oqueMaisPesa']     || body['dores'] || '',
    dores:            body['dores']             || body['O que mais pesa']  || '',
    historico:        body['Histórico']         || body['historico']        || body['Historico'] || '',
    saude:            body['Saúde']             || body['saude']            || body['Saude'] || '',
    comprometimento:  body['Comprometimento']   || body['comprometimento']  || '',
    maiorDificuldade: body['Maior dificuldade'] || body['maiorDificuldade'] || body['dificuldade'] || '',
    dificuldade:      body['dificuldade']       || body['Maior dificuldade']|| '',
    source:           body['source']            || body['Source']           || '',
  };
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'você';
}

function sourceIncludes(leadData, term) {
  return String(leadData.source || '').toLowerCase().includes(term);
}

function templateForLead(leadData) {
  if (sourceIncludes(leadData, 'natalia_kelm')) return null;
  if (
    sourceIncludes(leadData, 'formulario_consulta_evelyn')
    || sourceIncludes(leadData, 'consulta_evelyn')
    || sourceIncludes(leadData, 'evelyn_stories')
  ) {
    return 'pos_formulario_consulta_evelyn_vfinal';
  }
  return 'pos_formulario_padrao_vfinal';
}

function buildSdrBriefing(leadData, templateName) {
  return [
    `Source: ${leadData.source || 'formulário'}`,
    `Primeira mensagem enviada via API Oficial: ${templateName}`,
    `Dor/gancho: ${leadData.oqueMaisPesa || leadData.dores || leadData.maiorDificuldade || 'avaliar respostas do formulário'}`,
    `Histórico: ${leadData.historico || 'não informado'}`,
    `Próximo passo: aguardar resposta no Hub Table e conduzir pelo CRM`,
  ].join('\n');
}

async function sendOfficialFirstContact(leadData, phone) {
  const templateName = templateForLead(leadData);
  if (!templateName) return false;
  await sendOfficialTemplate({
    to: phone,
    templateName,
    params: [firstName(leadData.nome)],
  });
  await addMessage(phone, 'assistant', `[template oficial: ${templateName}]`);
  await notifySDR(leadData, buildSdrBriefing(leadData, templateName));
  console.log(`✅ Lead ${leadData.nome} iniciado via API Oficial (${templateName})`);
  return true;
}

async function processLead(leadData, phone) {
  // Persiste a lead no Redis ANTES da IA — garante que o CRM (hub-table)
  // sincronize a lead mesmo se a geração de mensagem / Z-API falhar.
  try {
    await activateLead(phone, leadData);
  } catch (e) {
    console.error(`⚠️ Falha ao persistir lead ${leadData.nome} no Redis:`, e.message);
  }

  try {
    try {
      const sentOfficial = await sendOfficialFirstContact(leadData, phone);
      if (sentOfficial) return;
    } catch (officialErr) {
      console.error(`❌ Falha ao iniciar ${leadData.nome} via API Oficial, usando fluxo legado:`, officialErr.message);
    }

    const result = await generateFirstContact(leadData);

    leadData._monitorarDePerto = result.orientacao?.monitorarDePerto || false;
    leadData._avisoNatalia = result.avisoNatalia || false;

    // Reatualiza com os campos derivados da IA (idempotente)
    await activateLead(phone, leadData);
    await addMessage(phone, 'assistant', result.leadMessage);

    if (!dentroDoHorario()) {
      console.log(`⏰ Lead ${leadData.nome} fora do horário — mensagem enfileirada`);
      await enqueueMessage(phone, `__PRIMEIRA_MENSAGEM__${result.leadMessage}`);
      await notifySDR(leadData, result.sdrBriefing);
      return;
    }

    await sendMessage(phone, result.leadMessage);
    await notifySDR(leadData, result.sdrBriefing);

    console.log(`✅ Lead ${leadData.nome} processado`);
  } catch (err) {
    console.error(`❌ Erro ao processar lead ${leadData.nome}:`, err.message);
  }
}

function authWebhook(req, res) {
  const secret = req.headers['x-webhook-secret'] || req.body.secret;
  if (secret !== process.env.WEBHOOK_SECRET) {
    console.warn('Tentativa de acesso com segredo inválido');
    res.status(401).json({ error: 'Não autorizado' });
    return false;
  }
  return true;
}

export async function handleMakeLead(req, res) {
  if (!authWebhook(req, res)) return;

  const leadData = normalizeLead(req.body);
  const phone = normalizePhone(leadData.whatsapp || leadData.whats);

  if (!phone) {
    return res.status(400).json({ error: 'Campo WhatsApp é obrigatório' });
  }

  console.log(`📥 Novo lead recebido: ${leadData.nome} (${phone})`);
  res.status(200).json({ received: true, phone });

  await processLead(leadData, phone);
}
