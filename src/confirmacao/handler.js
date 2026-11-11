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

// A porta de entrada (/webhook/confirmacao-preconsulta) saiu em 11/11/2026: no
// Hub, a confirmação de pré-consulta estava desligada desde 14/10 por duplicar
// mensagem, e o job foi removido. Nada novo entra.
//
// A condução da conversa fica, pelo mesmo motivo da oferta: resposta atrasada
// precisa achar o agente.
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
