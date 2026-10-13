// Oferta pós pré-consulta — Fase 3.
//
// O Hub decide QUEM entra (a nutri indicou o produto no card), QUANDO cada
// toque sai e com QUAL link (atribuição por nutri e produto). Aqui o agente
// decide o que escrever e conduz até a venda.
//
// Essa divisão é de propósito: elegibilidade e atribuição são regra de
// negócio, precisam ser auditáveis no banco e não podem depender de um prompt.
//
// A régua D+1/D+3/D+7 vale só para quem NÃO respondeu. A primeira resposta
// dela para a régua no Hub e a conversa passa a ser conduzida aqui.

import { generateOfertaMessage, generateOfertaReply } from '../ai/anthropic.js';
import {
  setOfertaMode, normalizePhone, addMessage, isBlocked, setHandedOff,
} from '../conversation/store.js';
import { sendMessage, notifyOferta } from '../zapi/sender.js';
import { pararReguaOferta, registrarDesfechoOferta } from '../hub/client.js';

export async function handleOferta(req, res) {
  const expected = process.env.HUB_WEBHOOK_SECRET || process.env.INTERNAL_WEBHOOK_SECRET;
  const received = req.headers['x-webhook-secret'] || req.body?.secret;
  if (!expected || received !== expected) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const phone = normalizePhone(req.body?.phone || '');
  const cardId = req.body?.card_id || null;
  if (!phone)  return res.status(400).json({ error: 'phone obrigatório' });
  if (!cardId) return res.status(400).json({ error: 'card_id obrigatório' });

  if (await isBlocked(phone)) {
    console.log(`⛔ Oferta recusada: ${phone} está bloqueado no sdr`);
    return res.status(409).json({ error: 'bloqueado', sent: false });
  }

  const dados = {
    nome:        req.body?.nome || null,
    nutri:       req.body?.nutri || null,
    produto:     req.body?.produto || null,
    oferta_url:  req.body?.oferta_url || null,
    jornada_url: req.body?.jornada_url || null,
    perfil:      req.body?.perfil || null,
    veio_do_pr:  req.body?.veio_do_pr === true,
    obs_form:    req.body?.obs_form || null,
    obs_nutri:   req.body?.obs_nutri || null,
    toque:       Number(req.body?.toque) || 0,
    card_id:     cardId,
  };

  // Responde antes de gerar: o worker do Hub não pode ficar preso esperando a
  // LLM, e a fila da hora não pode travar por causa de uma lead.
  res.json({ ok: true, queued: true, phone, toque: dados.toque });

  try {
    const ok = await setOfertaMode(phone, {
      nome: dados.nome, whatsapp: phone, cardId,
      origem: 'oferta_posconsulta',
      oferta: dados,
    });
    if (!ok) return;

    const mensagem = await generateOfertaMessage(dados);
    if (!mensagem) {
      console.error(`[oferta] mensagem vazia p/ ${phone} toque ${dados.toque} — nada enviado`);
      return;
    }
    await sendMessage(phone, mensagem);
    await addMessage(phone, 'assistant', mensagem).catch(() => {});
    console.log(`✅ Oferta toque ${dados.toque} enviada p/ ${dados.nome || phone} (card ${cardId})`);
  } catch (e) {
    console.error(`[oferta] erro p/ ${phone} toque ${dados.toque}:`, e.message);
  }
}

/**
 * Conduz a resposta da lead. Caminho próprio, interceptado antes da máquina do
 * SDR: qualificação, score e branch Evelyn não têm o que fazer aqui — esta
 * pessoa já foi qualificada por uma nutricionista numa consulta.
 */
export async function conduzirOferta({ phone, leadData = {}, history = [], mensagem, temImagem = false }) {
  const dados = leadData.oferta || {};
  const cardId = dados.card_id || leadData.cardId || null;

  // A primeira resposta dela encerra a régua. Antes de qualquer outra coisa:
  // se o resto falhar, o follow-up não pode continuar correndo por cima de uma
  // conversa viva.
  if (cardId) await pararReguaOferta(cardId).catch(() => {});

  const r = await generateOfertaReply({ dados, historico: history, mensagem, temImagem });

  if (r.mensagem) {
    await sendMessage(phone, r.mensagem);
    await addMessage(phone, 'assistant', r.mensagem).catch(() => {});
  }

  // Desfecho definido vai para a mesma tabela que a Karina preenche à mão.
  if (cardId && r.desfecho && r.desfecho !== 'em_andamento') {
    await registrarDesfechoOferta({
      cardId,
      desfecho: r.desfecho,
      objecao: r.objecao,
      objecaoTexto: String(mensagem || '').slice(0, 2000),
      handoffMotivo: r.handoff_motivo,
    }).catch(() => {});
  }

  if (r.handoff) {
    await setHandedOff(phone).catch(() => {});
    const rotulo = {
      comprovante:    temImagem ? 'mandou uma imagem (provável comprovante)' : 'disse que pagou',
      nao_sabia:      'perguntou algo que o agente não soube responder',
      sofrimento:     '🔴 SINAL DE SOFRIMENTO — atender com prioridade',
      pedido_da_lead: 'pediu para falar com uma pessoa',
      outro:          'precisa de atendimento humano',
    }[r.handoff_motivo] || 'precisa de atendimento humano';
    await notifyOferta({
      nome: leadData.nome, phone, produto: dados.produto, rotulo,
      textoDaLead: mensagem, desfecho: r.desfecho,
    }).catch(err => console.error('[oferta] aviso para a Karina falhou:', err.message));
  }

  console.log(`[oferta] ${phone} → desfecho ${r.desfecho}${r.objecao ? ` (${r.objecao})` : ''}${r.handoff ? ` · handoff ${r.handoff_motivo}` : ''}`);
  return r;
}
