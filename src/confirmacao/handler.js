// Confirmacao de pre-consulta — Fase 1 do agente comercial.
//
// O Hub decide QUEM e QUANDO (todas as pre-consultas de amanha, espalhadas
// numa janela da manha de hoje). Aqui o agente escreve, envia pela instancia
// Z-API da Karina e conduz a resposta.
//
// O agente MOVE o card: 'Confirmada' quando a pessoa vem, 'Reagendar' quando
// nao vem. A Karina faz a interacao de remarcacao e ajusta depois — por isso
// 'Reagendar' e nao 'Reagendada'.
//
// Ele nao reagenda, nao oferece horario e nao fala de produto. E a fase mais
// barata de errar, de proposito: e ela que valida o agente agindo sozinho.

import { generateConfirmacaoMessage, generateConfirmacaoReply } from '../ai/anthropic.js';
import { setConfirmacaoMode, normalizePhone, addMessage, isBlocked, setHandedOff } from '../conversation/store.js';
import { sendMessage, notifyConfirmacao } from '../zapi/sender.js';
import { moverCardPipeline } from '../hub/client.js';

export async function handleConfirmacaoPreConsulta(req, res) {
  const expected = process.env.HUB_WEBHOOK_SECRET || process.env.INTERNAL_WEBHOOK_SECRET;
  const received = req.headers['x-webhook-secret'] || req.body?.secret;
  if (!expected || received !== expected) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const phone = normalizePhone(req.body?.phone || req.body?.whatsapp || '');
  if (!phone) return res.status(400).json({ error: 'phone obrigatório' });

  const cardId = req.body?.card_id || null;
  if (!cardId) return res.status(400).json({ error: 'card_id obrigatório' });

  // Bloqueio local tem precedencia sobre a decisao do Hub: quem recusou
  // contato pode ter recusado por aqui, e nesse caso o Hub nem sabe.
  if (await isBlocked(phone)) {
    console.log(`⛔ Confirmação recusada: ${phone} está bloqueado no sdr`);
    return res.status(409).json({ error: 'bloqueado', sent: false });
  }

  const nome  = req.body?.nome || null;
  const nutri = req.body?.nutri || null;
  const quando = req.body?.quando || null; // já formatado em BRT pelo Hub

  // Responde antes de enviar: o Hub nao pode ficar preso esperando a LLM, e o
  // lote da hora inteira nao pode travar por causa de uma lead.
  res.json({ ok: true, queued: true, phone });

  try {
    const ok = await setConfirmacaoMode(phone, {
      nome,
      whatsapp: phone,
      cardId,
      nutri,
      origem: 'confirmacao_preconsulta',
      confirmacao: { card_id: cardId, quando, nutri },
    });
    if (!ok) return; // bloqueado entre a checagem e agora

    const mensagem = await generateConfirmacaoMessage({ nome, quando, nutri });
    if (!mensagem) {
      console.error(`[confirmacao] mensagem vazia para ${phone} — nada enviado`);
      return;
    }
    await sendMessage(phone, mensagem);
    await addMessage(phone, 'assistant', mensagem).catch(() => {});
    console.log(`✅ Confirmação enviada para ${nome || phone} (card ${cardId})`);
  } catch (e) {
    console.error(`[confirmacao] erro para ${phone}:`, e.message);
  }
}


// Estagio do pipeline por classificacao. 'Reagendar' (nao 'Reagendada'):
// a remarcacao ainda nao aconteceu, e e a Karina quem faz.
const ESTAGIO = { confirmou: 'Confirmada', nao_pode: 'Reagendar' };

/**
 * Conduz a resposta da lead na confirmacao. Caminho curto e proprio, chamado
 * pelo zapiHandler ANTES da maquina do SDR: aqui nao existe qualificacao,
 * branch Evelyn nem handoff de agendamento — e so "voce vem amanha?".
 */
export async function conduzirConfirmacao({ phone, leadData = {}, history = [], mensagem }) {
  const ctx = leadData.confirmacao || {};
  const r = await generateConfirmacaoReply({
    nome: leadData.nome,
    quando: ctx.quando,
    nutri: ctx.nutri,
    historico: history,
    mensagem,
  });

  if (r.mensagem) {
    await sendMessage(phone, r.mensagem);
    await addMessage(phone, 'assistant', r.mensagem).catch(() => {});
  }

  const stage = ESTAGIO[r.classificacao] || null;
  let movido = false;
  if (stage && ctx.card_id) {
    movido = await moverCardPipeline({ cardId: ctx.card_id, stage, phone, motivo: r.classificacao });
  }

  // A Karina e avisada em TODO caso que nao seja uma confirmacao limpa: quem
  // nao vem precisa de remarcacao (trabalho dela), e indefinido precisa de
  // gente. Se o movimento do card falhar, ela tambem e avisada para mover na
  // mao — senao a conversa aconteceu e o pipeline nao soube.
  const precisaDeGente = r.classificacao !== 'confirmou' || !movido;
  if (precisaDeGente) {
    const rotulo = {
      confirmou: 'confirmou presença',
      nao_pode: 'NÃO vai poder vir, precisa remarcar',
      indefinido: 'respondeu algo fora da confirmação',
    }[r.classificacao] || 'respondeu';
    const aviso = stage
      ? (movido ? `✅ Card movido para ${stage}.` : `⚠️ NÃO consegui mover o card para ${stage} — mova na mão.`)
      : '⚠️ Card não movido.';
    await notifyConfirmacao({
      nome: leadData.nome, phone, rotulo, textoDaLead: mensagem, aviso,
    }).catch(err => console.error('[confirmacao] aviso para a Karina falhou:', err.message));
  }

  // Indefinido sai do automatico: a proxima mensagem dela e com uma pessoa.
  if (r.handoff) await setHandedOff(phone).catch(() => {});

  console.log(`[confirmacao] ${phone} → ${r.classificacao}${stage ? ` (card ${movido ? 'movido' : 'NÃO movido'} para ${stage})` : ''}`);
  return { classificacao: r.classificacao, stage, movido };
}
