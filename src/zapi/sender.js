// src/zapi/sender.js

import axios from 'axios';
import { config } from '../../config/index.js';
import { getLeadData, isBlocked, normalizePhone } from '../conversation/store.js';

// Anexa a join key (sck = lead_event_id do quiz) aos links da Cakto na mensagem,
// para que a compra feita por esse link seja atribuível ao anúncio via CAPI
// (o webhook Cakto devolve data.sck → enrichFromLid puxa o fbc do lead). Sem
// lead_event_id conhecido, o link segue sem sck — mesmo comportamento de antes.
async function withCaktoSck(phone, message) {
  try {
    if (!/pay\.cakto\.com\.br\//.test(message)) return message;
    const lead = await getLeadData(phone);
    const sck = lead && lead.lead_event_id;
    if (!sck) return message;
    return message.replace(/https:\/\/pay\.cakto\.com\.br\/[A-Za-z0-9_]+(\?[^\s]*)?/g, function (url) {
      if (/[?&]sck=/.test(url)) return url; // já tem sck
      return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'sck=' + encodeURIComponent(sck);
    });
  } catch {
    return message;
  }
}

const zapiClient = axios.create({
  baseURL: config.zapi.baseUrl(),
  headers: {
    'Content-Type': 'application/json',
    'Client-Token': config.zapi.clientToken,
  },
});

function typingDelay(message) {
  const len = message.length;
  if (len <= 80)  return Math.floor(Math.random() * (12000 - 8000) + 8000);
  if (len <= 200) return Math.floor(Math.random() * (25000 - 15000) + 15000);
  return Math.floor(Math.random() * (45000 - 30000) + 30000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function getSendErrorDetail(error) {
  const data = error?.response?.data;
  if (typeof data === 'string' && data.trim()) return data.trim();
  if (data?.error && typeof data.error === 'string') return data.error;
  if (data?.message && typeof data.message === 'string') return data.message;
  if (data) {
    try { return JSON.stringify(data); } catch { /* usa a mensagem abaixo */ }
  }
  return error?.message || 'Erro desconhecido no envio';
}

function requireNonEmptyMessage(message) {
  if (typeof message !== 'string' || !message.trim()) {
    const error = new Error('Mensagem vazia bloqueada antes do envio');
    error.code = 'EMPTY_OUTGOING_MESSAGE';
    throw error;
  }
  return message.trim();
}

async function sendToAll(message, options = {}) {
  await sendMessage(config.sdr.phone, message, options);
  if (process.env.NUMERO_BACKUP) {
    await sendMessage(process.env.NUMERO_BACKUP, message, options);
  }
}

// A Karina e o número de backup nunca são silenciados pelo blocklist: são o
// canal de notificação (handoff, red flag, erro). Bloqueá-los por engano
// derrubaria a operação inteira em silêncio.
function isProtectedPhone(phone) {
  const alvo = normalizePhone(String(phone || ''));
  return [config.sdr.phone, process.env.NUMERO_BACKUP]
    .filter(Boolean)
    .some(p => normalizePhone(String(p)) === alvo);
}

export async function sendMessage(phone, message, options = {}) {
  try {
    // Valida antes de consultar Redis, esperar o typing delay ou tocar na API.
    // Assim um bug de geração nunca vira uma requisição 400 na Z-API.
    const validMessage = requireNonEmptyMessage(message);
    // Último guard antes do envio: cobre qualquer caminho (agente, follow-up,
    // disparo, recuperação de checkout) sem depender de cada chamador lembrar.
    if (!isProtectedPhone(phone) && await isBlocked(phone)) {
      console.log(`⛔ Envio cancelado para ${phone} (número bloqueado)`);
      return null;
    }
    const outgoing = requireNonEmptyMessage(await withCaktoSck(phone, validMessage));
    if (!options.skipDelay) {
      const delay = typingDelay(outgoing);
      console.log(`⏳ Aguardando ${Math.round(delay/1000)}s antes de enviar para ${phone}`);
      await sleep(delay);
    }
    const response = await zapiClient.post('/send-text', { phone, message: outgoing });
    console.log(`✅ Mensagem enviada para ${phone}`);
    return response.data;
  } catch (error) {
    const detail = getSendErrorDetail(error);
    error.deliveryDetail = detail;
    console.error(`❌ Erro ao enviar para ${phone}:`, detail);
    throw error;
  }
}

export async function notifySDR(leadData, sdrBriefing) {
  const cleanPhone = (leadData.whatsapp || leadData.whats || '').replace(/\D/g, '');
  const score = leadData.qualificacao?.score ?? leadData.score ?? '?';
  const tier = (leadData.qualificacao?.tier || leadData.temperatura || '').toUpperCase();
  const monitorar = leadData._monitorarDePerto;
  const avisoNatalia = leadData._avisoNatalia;

  const lines = [
    `🎯 *NOVO LEAD ATIVADO*`,
    ``,
    avisoNatalia ? `⚠️ *LEAD DA NATÁLIA KELM*\nPré-consulta com a Natália. Não ofereça o Protocolo Raiz.\n` : null,
    monitorar ? `🔴 *MONITORAR DE PERTO*\n` : null,
    `👤 *${leadData.nome}*`,
    `🌡️ ${tier} | Score: ${score}/10`,
    ``,
    `📊 *Briefing:*`,
    sdrBriefing,
    ``,
    `🔗 https://wa.me/${cleanPhone}`,
  ].filter(l => l !== null);

  await sendToAll(lines.join('\n'), { skipDelay: true });
}

/**
 * Aviso de confirmacao de pre-consulta para a Karina.
 *
 * Separado do notifySDR porque aquele formata "NOVO LEAD ATIVADO" com score e
 * briefing — aqui nao existe nem um nem outro, e o que ela precisa saber e
 * curto: quem respondeu o que, e se o card se moveu sozinho ou se ela tem de
 * mover na mao.
 */
export async function notifyConfirmacao({ nome, phone, rotulo, textoDaLead, aviso }) {
  const limpo = String(phone || '').replace(/\D/g, '');
  const lines = [
    `🗓️ *CONFIRMAÇÃO DE PRÉ-CONSULTA*`,
    ``,
    `👤 *${nome || limpo}* — ${rotulo}`,
    textoDaLead ? `\n💬 "${String(textoDaLead).slice(0, 300)}"` : null,
    aviso ? `\n${aviso}` : null,
    ``,
    `🔗 https://wa.me/${limpo}`,
  ].filter(l => l !== null);
  await sendToAll(lines.join('\n'), { skipDelay: true });
}

/** Aviso de handoff na oferta pos pre-consulta. */
export async function notifyOferta({ nome, phone, produto, rotulo, textoDaLead, desfecho }) {
  const limpo = String(phone || '').replace(/\D/g, '');
  const lines = [
    `💰 *OFERTA — PRECISA DE VOCÊ*`,
    ``,
    `👤 *${nome || limpo}*${produto ? ` · ${produto}` : ''}`,
    rotulo,
    textoDaLead ? `\n💬 "${String(textoDaLead).slice(0, 300)}"` : null,
    desfecho && desfecho !== 'em_andamento' ? `\nDesfecho registrado: ${desfecho}` : null,
    ``,
    `🔗 https://wa.me/${limpo}`,
  ].filter(l => l !== null);
  await sendToAll(lines.join('\n'), { skipDelay: true });
}

export async function notifySDRHandoff(leadData, turno, handoffBriefing) {
  const cleanPhone = (leadData.whatsapp || leadData.whats || '').replace(/\D/g, '');
  const score = leadData.qualificacao?.score ?? leadData.score ?? '?';
  const tier = (leadData.qualificacao?.tier || leadData.temperatura || '').toUpperCase();

  const lines = [
    `🟢 *HANDOFF — PRONTA PARA AGENDAR*`,
    ``,
    `👤 *${leadData.nome}* | ${tier} | Score: ${score}/10`,
    `🕐 Turno preferido: *${turno}*`,
    ``,
    `📋 *Resumo da conversa:*`,
    handoffBriefing,
    ``,
    `🔗 https://wa.me/${cleanPhone}`,
  ];

  await sendToAll(lines.join('\n'), { skipDelay: true });
}

// Handoff de RETOMADA. Visual deliberadamente diferente do handoff normal:
// a Karina precisa bater o olho e saber que é uma lead antiga voltando, não
// uma pré-consulta nova. O agente conduz até a abertura e para aqui — ele não
// tem o link da oferta nem o histórico da conversa antiga, então tentar fechar
// sozinho seria pior que passar a bola.
export async function notifySDRRetomada(leadData, briefing, ctx = {}) {
  const cleanPhone = (leadData.whatsapp || leadData.whats || '').replace(/\D/g, '');
  const icp = ctx.icpScore != null ? `${ctx.icpScore}/100` : '—';

  const lines = [
    `🔁 *RETOMADA — LEAD ANTIGA QUER VOLTAR*`,
    ``,
    `👤 *${leadData.nome || 'Sem nome'}*`,
    `🎯 Fit ICP: ${icp}${ctx.persona ? ` · ${ctx.persona}` : ''}`,
    ctx.recomendacao ? `💡 Hipótese de entrega: ${ctx.recomendacao}` : null,
    ctx.motivoPerda ? `📌 Na época: ${ctx.motivoPerda}` : null,
    ``,
    `📋 *O que ela trouxe agora:*`,
    briefing,
    ``,
    `⚠️ Ela já conhece a Table — não recomece do zero.`,
    `🔗 https://wa.me/${cleanPhone}`,
  ].filter(l => l !== null);

  await sendToAll(lines.join('\n'), { skipDelay: true });
}

export async function notifySDRRedflag(leadData, motivo) {
  const cleanPhone = (leadData.whatsapp || leadData.whats || '').replace(/\D/g, '');

  const lines = [
    `🚨 *RED FLAG — ATENÇÃO IMEDIATA*`,
    ``,
    `👤 *${leadData.nome}*`,
    `🔗 https://wa.me/${cleanPhone}`,
    ``,
    `⚠️ *Motivo:* ${motivo}`,
    ``,
    `O agente parou de responder. Assuma a conversa com cuidado.`,
  ];

  await sendToAll(lines.join('\n'), { skipDelay: true });
}

export async function notifySDRTurnLimit(leadData, handoffBriefing) {
  const cleanPhone = (leadData.whatsapp || leadData.whats || '').replace(/\D/g, '');
  const score = leadData.qualificacao?.score ?? leadData.score ?? '?';
  const tier = (leadData.qualificacao?.tier || leadData.temperatura || '').toUpperCase();

  const lines = [
    `🛑 *TETO DE TURNOS ATINGIDO*`,
    ``,
    `👤 *${leadData.nome}* | ${tier} | Score: ${score}/10`,
    ``,
    `📋 *Resumo da conversa:*`,
    handoffBriefing,
    ``,
    `O agente pausou após 15 trocas. Assuma a conversa.`,
    `🔗 https://wa.me/${cleanPhone}`,
  ];

  await sendToAll(lines.join('\n'), { skipDelay: true });
}

export async function notifyManualHandoffBatch({ title, leads }) {
  const lines = [
    title || `⚠️ *Leads para ativação manual*`,
    ``,
    `Total: ${leads.length}`,
    ``,
  ];

  leads.forEach((lead, idx) => {
    const cleanPhone = String(lead.phone || lead.whatsapp || lead.whats || '').replace(/\D/g, '');
    lines.push(`${idx + 1}. *${lead.nome || lead.name || 'Lead'}*`);
    if (lead.source) lines.push(`Fonte: ${lead.source}`);
    if (lead.status) lines.push(`Status: ${lead.status}`);
    if (lead.lastUser) lines.push(`Última resposta: "${String(lead.lastUser).slice(0, 240)}"`);
    if (cleanPhone) lines.push(`🔗 https://wa.me/${cleanPhone}`);
    lines.push('');
  });

  await sendToAll(lines.join('\n'), { skipDelay: true });
}

// ── Campanha sazonal (Lista VIP Evelyn Liu) ──────────────────────────────────

function campanhaCleanPhone(participant) {
  return String(participant?.phone || participant?.telefone || '').replace(/\D/g, '');
}

// Handoff principal: lead respondeu positivamente. Se a campanha já encerrou
// (closed), vira aviso interno SEM prometer disponibilidade.
export async function notifyKarinaCampanhaHandoff(participant, text, { closed } = {}) {
  const nome = participant?.nome || 'Lead';
  const phone = campanhaCleanPhone(participant);
  const link = phone ? `🔗 https://wa.me/${phone}` : '';

  if (closed) {
    const lines = [
      `⚠️ *LISTA VIP EVELYN LIU — RESPOSTA APÓS ENCERRAMENTO*`,
      ``,
      `👤 *${nome}*`,
      `💬 Resposta: "${String(text || '').slice(0, 280)}"`,
      ``,
      `As 3 vagas já foram preenchidas. *Não prometa disponibilidade.*`,
      `Se fizer sentido, registre como lista de espera para uma próxima abertura.`,
      link,
    ].filter(Boolean);
    await sendToAll(lines.join('\n'), { skipDelay: true });
    return;
  }

  const lines = [
    `🤍 *Lead - Lista VIP Evelyn Liu*`,
    ``,
    `👤 *${nome}*`,
    `💬 Resposta: "${String(text || '').slice(0, 280)}"`,
    ``,
    `• Lead respondeu positivamente à campanha sazonal.`,
    `• Lead respondeu a uma campanha antiga. Não ofereça consulta avulsa.`,
    `• Se houver intenção explícita de acompanhamento direto com a Evelyn, conduza pela modalidade atual de 3 meses.`,
    `• Abertura pontual (sem trava automática de vagas) — negocie normalmente mesmo além das 3 primeiras respostas.`,
    ``,
    `*Próxima ação:* entrar em contato pelo WhatsApp para apresentar os horários e conduzir o agendamento.`,
    link,
  ].filter(Boolean);

  await sendToAll(lines.join('\n'), { skipDelay: true });
}

// Aviso leve: o participante respondeu algo que não foi classificado como
// interesse positivo. Não move o card; só garante que nada se perca.
export async function notifyKarinaCampanhaResposta(participant, text, { positive } = {}) {
  const nome = participant?.nome || 'Lead';
  const phone = campanhaCleanPhone(participant);
  const link = phone ? `🔗 https://wa.me/${phone}` : '';
  const lines = [
    `📩 *Lista VIP Evelyn Liu — resposta recebida*`,
    ``,
    `👤 *${nome}*`,
    `💬 "${String(text || '').slice(0, 280)}"`,
    ``,
    `Sem sinal claro de interesse — avalie se vale responder manualmente.`,
    link,
  ].filter(Boolean);
  await sendToAll(lines.join('\n'), { skipDelay: true });
}

export async function notifyError(phone, errorMessage) {
  const lines = [
    `⚠️ *ERRO AO RESPONDER LEAD*`,
    ``,
    `📱 Número: ${phone}`,
    `❌ Erro: ${errorMessage}`,
    ``,
    `Verifique a conversa e responda manualmente se necessário.`,
    `🔗 https://wa.me/${phone}`,
  ];

  await sendToAll(lines.join('\n'), { skipDelay: true });
}

export async function notifySDRManualReview(phone, briefing) {
  const lines = [
    `⚠️ *CONVERSA PAUSADA PARA REVISÃO*`,
    ``,
    `📱 Número: ${phone}`,
    `📋 ${briefing}`,
    ``,
    `A lead recebeu uma mensagem de continuidade. Assuma a conversa quando possível.`,
    `🔗 https://wa.me/${phone}`,
  ];

  await sendToAll(lines.join('\n'), { skipDelay: true });
}

// ─── Avisos do inbound (anúncio / story) ─────────────────────────────────────
//
// O aviso sai pela instância da KARINA, não pela do inbound. É onde ela já
// recebe handoff, red flag e erro — misturar canal de notificação com canal de
// conversa só criaria um segundo lugar para ela ter de olhar.

const INBOUND_ROTULO_MOTIVO = {
  pronta_para_agendar: '🟢 Qualificada e pronta para agendar',
  pediu_evelyn:        '👤 Pediu atendimento direto com a Evelyn',
  pediu_humano:        '🙋 Pediu para falar com uma pessoa',
  fora_do_roteiro:     '❓ Perguntou algo que o agente não soube responder',
  ja_paciente:         '⚠️ Diz que já é paciente ou já tem acompanhamento',
  erro_tecnico:        '🔧 Falha técnica do agente — assumir a conversa',
};

const INBOUND_ORIGEM_ROTULO = {
  anuncio: 'Anúncio (click-to-WhatsApp)',
  story:   'Story',
  bio:     'Bio / perfil',
  direto:  'Link direto',
};

/**
 * Handoff do inbound. Formato deliberadamente diferente do handoff normal: aqui
 * a Karina precisa LIGAR DE OUTRO NÚMERO, e a lead já foi avisada disso. O que
 * ela precisa ver de imediato é a disponibilidade, porque é com ela que a
 * conversa dela começa.
 */
export async function notifyInbound({
  nome, phone, motivo, score, tier, disponibilidade = {}, briefing, qualificacao = {}, origem, textoDaLead,
}) {
  const limpo = String(phone || '').replace(/\D/g, '');
  const turnos = (disponibilidade.turnos || []).join(', ');
  const dias = (disponibilidade.dias || []).join(', ');
  const temAgenda = !!(turnos && dias);

  const lines = [
    `📲 *INBOUND WHATSAPP — PRECISA DE VOCÊ*`,
    ``,
    INBOUND_ROTULO_MOTIVO[motivo] || 'Precisa de atendimento humano',
    ``,
    `👤 *${nome || limpo}*`,
    `📍 ${INBOUND_ORIGEM_ROTULO[origem] || origem || 'origem não identificada'}`,
    score != null ? `🌡️ ${String(tier || '').toUpperCase()} | Score: ${score}/10` : null,
    ``,
    temAgenda
      ? `🗓️ *Disponibilidade dela:*\n   Turnos: ${turnos}\n   Dias: ${dias}${disponibilidade.texto ? `\n   Nas palavras dela: "${disponibilidade.texto.slice(0, 200)}"` : ''}`
      : `🗓️ *Disponibilidade:* não chegou a ser mapeada`,
    ``,
    qualificacao.dor_texto ? `💬 *O que ela trouxe:*\n"${qualificacao.dor_texto.slice(0, 400)}"` : null,
    briefing ? `\n📋 *Briefing:*\n${briefing}` : null,
    textoDaLead ? `\n💬 Última mensagem: "${String(textoDaLead).slice(0, 300)}"` : null,
    ``,
    temAgenda
      ? `➡️ Ela JÁ FOI AVISADA que você chama de outro número, com as opções de horário.`
      : `➡️ Assuma a conversa pelo número do inbound.`,
    `🔗 https://wa.me/${limpo}`,
  ].filter(l => l !== null);

  await sendToAll(lines.join('\n'), { skipDelay: true });
}

/** Lead nova entrou pelo inbound. Aviso curto: ainda não tem nada para fazer. */
export async function notifyInboundNova({ phone, origem, ctwa }) {
  const limpo = String(phone || '').replace(/\D/g, '');
  const lines = [
    `📲 *Nova lead no inbound*`,
    `📍 ${INBOUND_ORIGEM_ROTULO[origem] || origem || '—'}`,
    ctwa?.sourceId ? `🎯 Anúncio: ${ctwa.sourceId}` : null,
    `🔗 https://wa.me/${limpo}`,
    ``,
    `O agente está qualificando. Você é chamada quando tiver disponibilidade mapeada.`,
  ].filter(l => l !== null);
  await sendToAll(lines.join('\n'), { skipDelay: true });
}
