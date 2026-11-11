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

// A porta de entrada (/webhook/oferta, chamada pelo worker do Hub) saiu em
// 11/11/2026 junto com o worker: a régua D+0/D+1/D+3/D+7 mandava pela Z-API do
// número comercial e foi desligada. Nada novo entra.
//
// O que conduz a conversa fica: quem já recebeu uma oferta antes do corte pode
// responder hoje, e precisa encontrar o agente do outro lado em vez de uma
// resposta genérica.
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
