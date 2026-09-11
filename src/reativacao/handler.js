// Reativação de leads — o Hub decide QUEM e QUANDO; aqui o agente compõe a
// primeira mensagem, envia e conduz a conversa.
//
// Diferença deliberada para a campanha sazonal (src/campanha/handler.js):
// lá a resposta é interceptada e entregue à Karina. Aqui não — a conversa
// entra no fluxo normal do agente em modo 'reativacao', e a equipe só assume
// quando o próprio agente pede handoff. O time é enxuto e monitora; não conduz.

import { generateReactivationMessage } from '../ai/anthropic.js';
import { setReactivationMode, normalizePhone, addMessage, isBlocked } from '../conversation/store.js';
import { sendMessage } from '../zapi/sender.js';
import { clearParticipant } from '../campanha/handler.js';

// Chamado pelo Hub no horário agendado de cada lead. Autentica pelo mesmo
// segredo interno dos demais webhooks Hub↔sdr.
export async function handleReativacaoRegistro(req, res) {
  const expected = process.env.HUB_WEBHOOK_SECRET || process.env.INTERNAL_WEBHOOK_SECRET;
  const received = req.headers['x-webhook-secret'] || req.body?.secret;
  if (!expected || received !== expected) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const phone = normalizePhone(req.body?.phone || req.body?.telefone || '');
  if (!phone) return res.status(400).json({ error: 'phone obrigatório' });

  // Bloqueio local tem precedência sobre qualquer decisão do Hub. O Hub já
  // checa opt-out do lado dele, mas quem recusou contato pode ter recusado
  // por aqui — e nesse caso o registro nem existe lá.
  if (await isBlocked(phone)) {
    console.log(`⛔ Reativação recusada: ${phone} está bloqueado no sdr`);
    return res.status(409).json({ error: 'bloqueado', sent: false });
  }

  const ctx = req.body?.reactivation || {};
  const leadData = {
    nome: req.body?.nome || null,
    whatsapp: phone,
    leadId: req.body?.lead_id || null,
    cardId: req.body?.card_id || null,
    origem: 'reativacao',
    reativacao: {
      campaignId: ctx.campaign_id || null,
      targetId: ctx.target_id || null,
      icpScore: ctx.icp_score ?? null,
      icpVersion: ctx.icp_model_version || null,
      persona: ctx.persona || null,
      briefing: ctx.briefing || null,
      recomendacao: ctx.commercial_recommendation || null,
      motivoPerda: ctx.motivo_perda || null,
      ultimoContato: ctx.ultimo_contato || null,
      ciclo: ctx.cycle_number || 1,
    },
  };

  try {
    // Lead que já participou de campanha sazonal continua registrada como
    // participante, e o zapiHandler intercepta essa resposta antes do agente
    // (entrega direto pra Karina). Limpar aqui é o que garante que a conversa
    // de reativação siga para o agente, como combinado.
    await clearParticipant(phone);

    // 1) Modo primeiro: se o envio der certo e a lead responder rápido, a
    //    conversa já precisa estar marcada como reativação.
    const ativou = await setReactivationMode(phone, leadData);
    if (!ativou) return res.status(409).json({ error: 'bloqueado', sent: false });

    // 2) O agente compõe a abertura com o contexto — sem recitá-lo à lead.
    const mensagem = await generateReactivationMessage({
      nome: leadData.nome,
      persona: leadData.reativacao.persona,
      briefing: leadData.reativacao.briefing,
      ultimoContato: leadData.reativacao.ultimoContato,
      motivoPerda: leadData.reativacao.motivoPerda,
      icpScore: leadData.reativacao.icpScore,
      recomendacao: leadData.reativacao.recomendacao,
    });
    if (!mensagem) {
      console.error(`[reativacao] mensagem vazia para ${phone}`);
      return res.status(502).json({ error: 'mensagem_vazia', sent: false });
    }

    await sendMessage(phone, mensagem);
    await addMessage(phone, 'assistant', mensagem);

    console.log(`💬 Reativação enviada: ${phone} (${leadData.nome || 's/ nome'})`);
    return res.json({ ok: true, sent: true, message: mensagem });
  } catch (err) {
    console.error(`[reativacao] falha ao abrir conversa com ${phone}:`, err.message);
    return res.status(500).json({ error: err.message, sent: false });
  }
}
