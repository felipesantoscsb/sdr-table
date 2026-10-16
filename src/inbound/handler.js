// Inbound WhatsApp — agente de entrada (anúncio / story).
//
// A pessoa clica no anúncio e cai direto na conversa, sem formulário antes.
// Por isso a qualificação toda acontece aqui, e tem de ser mais robusta que a
// do SDR normal: é ela que decide se a lead merece a agenda de uma
// nutricionista. Marcar pré-consulta ruim queima horário e não fecha.
//
// A Karina agenda DE OUTRO NÚMERO. Isso muda duas coisas:
//   1. o agente precisa mapear turno E dias antes de passar a bola;
//   2. a lead precisa ser avisada de que o contato vem de outro número, ou
//      ignora achando que é golpe.
//
// O gate de handoff (turnos + dias) é aplicado em normalizarRespostaInbound,
// no código. O prompt pede, o código garante.

import {
  generateInboundFirstContact, generateInboundReply,
} from '../ai/anthropic.js';
import {
  setInboundMode, getInboundState, setInboundState, addMessage,
  setHandedOff, isBlocked, normalizePhone, deactivateLead, getLeadData,
  temConversaInbound,
} from '../conversation/store.js';
import { sendInboundMessage, inboundConfigStatus } from '../zapi/senderInbound.js';
import { notifyInbound, notifyInboundNova } from '../zapi/sender.js';
import {
  garantirLeadCaptacaoNoHub, migrarParaPreConsulta,
  verificarElegibilidadeContatoSdr, bloqueioDefinitivoSdr,
} from '../hub/client.js';

// Desligar o fluxo inteiro com uma linha, sem depender do Railway. Mesmo
// padrão dos outros flags do projeto, pela mesma razão: quando algo dispara
// mensagem indevida, a correção precisa ser um deploy, não um painel.
const INBOUND_HARD_OFF = false;

export function inboundAtivo() {
  return !INBOUND_HARD_OFF && process.env.INBOUND_SDR_ENABLED !== 'false';
}

// Rótulos legíveis para o card no Hub e para o briefing. O Hub recebe os mesmos
// campos de sempre (oqueMaisPesa, historico, saude...) — assim o card do
// inbound fica igual a qualquer outro, sem alteração nenhuma no Hub.
const LABEL_PADRAO = {
  escape: 'Come por ansiedade ou estresse (escape)',
  ciclo: 'Restrição que vira perda de controle (ciclo)',
  culpa: 'Culpa depois de comer',
  autoestima: 'Relação com o corpo e autoestima abaladas',
  rotina: 'Rotina e cansaço falam mais alto',
  saude: 'Motivação principal é saúde',
  nao_informado: 'Não informado',
};
const LABEL_TENTATIVA = {
  dieta: 'Dieta restritiva / low carb', jejum: 'Jejum intermitente',
  nutri: 'Nutricionista convencional', nutri_comp: 'Nutrição comportamental / psicologia alimentar',
  psi: 'Psicólogo ou psiquiatra', remedio: 'Medicação prescrita',
  coach: 'Coach ou programa online', cirurgia: 'Cirurgia bariátrica', nenhum: 'Nada antes',
};
const LABEL_SAUDE = {
  hipo: 'Hipotireoidismo', sop: 'SOP', ri: 'Resistência à insulina',
  diabetes: 'Diabetes tipo 2', meno: 'Menopausa', ansiedade: 'Ansiedade / depressão',
  colesterol: 'Colesterol alto', nenhuma: 'Nenhuma', nao_informado: 'Não informado',
};
const LABEL_TURNO = { manha: 'manhã', tarde: 'tarde', noite: 'noite' };
const LABEL_DIA = {
  seg: 'segunda', ter: 'terça', qua: 'quarta', qui: 'quinta',
  sex: 'sexta', sab: 'sábado', dom: 'domingo',
};

function textoDisponibilidade(d = {}) {
  const turnos = (d.turnos || []).map(t => LABEL_TURNO[t] || t);
  const dias = (d.dias || []).map(x => LABEL_DIA[x] || x);
  if (!turnos.length && !dias.length) return null;
  return [
    turnos.length ? turnos.join(' / ') : null,
    dias.length ? `nos dias: ${dias.join(', ')}` : null,
  ].filter(Boolean).join(' — ');
}

/** Campos do card no Hub, no mesmo formato que o formulário de captação usa. */
function camposParaOHub({ nome, phone, origem, qualificacao = {}, disponibilidade = {}, score, tier }) {
  const q = qualificacao;
  return {
    nome: nome || 'Lead inbound',
    whatsapp: phone,
    whats: phone,
    source: `inbound_${origem || 'direto'}`,
    origin: 'WhatsApp Inbound',
    temperatura: tier,
    tier,
    score,
    oqueMaisPesa: LABEL_PADRAO[q.padrao] || null,
    maiorDificuldade: q.dor_texto || null,
    dificuldade: q.dor_texto || null,
    historico: (q.tentativas || []).map(t => LABEL_TENTATIVA[t] || t),
    saude: (q.saude || []).map(s => LABEL_SAUDE[s] || s).join(', ') || null,
    comprometimento: q.prontidao && q.prontidao !== 'nao_informado' ? `Prontidão ${q.prontidao}` : null,
    disponibilidadeTexto: textoDisponibilidade(disponibilidade),
  };
}

/**
 * Abre a conversa. Só é chamada quando detectarEntrada casou: resposta de
 * pesquisa de satisfação nunca chega aqui.
 */
export async function iniciarInbound({ phone, origem = 'direto', ctwa = null, mensagemOriginal = '' }) {
  if (!inboundAtivo()) {
    console.log(`[inbound] desligado — entrada de ${phone} ignorada`);
    return { ok: false, motivo: 'desligado' };
  }

  if (await isBlocked(phone)) {
    console.log(`⛔ [inbound] ${normalizePhone(phone)} está bloqueado — nada enviado`);
    return { ok: false, motivo: 'bloqueado' };
  }

  // Quem já é paciente da Table não pode ser tratada como lead nova de
  // captação. Só o veto definitivo do Hub bloqueia; indisponibilidade não
  // silencia o agente (mesma política fail-open do resto do SDR).
  const leadParcial = { nome: null, whatsapp: phone, source: `inbound_${origem}` };
  const eligibility = await verificarElegibilidadeContatoSdr({
    phone, leadData: leadParcial, source: `inbound_${origem}`, purpose: 'activation',
  }).catch(() => ({ allowed: true, reason: 'check indisponível' }));

  if (bloqueioDefinitivoSdr(eligibility)) {
    console.warn(`🛑 [inbound] entrada bloqueada para ${phone}: ${eligibility.reason}`);
    await notifyInbound({
      phone, origem, motivo: 'ja_paciente',
      textoDaLead: mensagemOriginal,
      briefing: `Esta pessoa já tem vínculo no Hub (${eligibility.reason}). O agente não respondeu; assuma pelo número do inbound.`,
    }).catch(() => {});
    return { ok: false, motivo: 'ja_paciente' };
  }

  const ok = await setInboundMode(phone, { nome: null, whatsapp: phone, origem, ctwa, source: `inbound_${origem}` });
  if (!ok) return { ok: false, motivo: 'bloqueado' };

  const r = await generateInboundFirstContact({ origem });
  if (!r.ok || !r.leadMessage) {
    console.error(`[inbound] primeira mensagem vazia p/ ${phone} — nada enviado`);
    await notifyInbound({
      phone, origem, motivo: 'erro_tecnico', textoDaLead: mensagemOriginal,
      briefing: 'O agente falhou ao gerar a primeira mensagem. A lead está esperando resposta.',
    }).catch(() => {});
    return { ok: false, motivo: 'erro_geracao' };
  }

  await sendInboundMessage(phone, r.leadMessage);
  await addMessage(phone, 'assistant', r.leadMessage).catch(() => {});
  await setInboundState(phone, { mensagensDoAgente: 1 });

  // Card de captação é bookkeeping: não condiciona a conversa.
  garantirLeadCaptacaoNoHub({
    leadData: camposParaOHub({ phone, origem, score: 0, tier: 'cold' }),
    phone,
  }).catch(err => console.warn(`[inbound] card não criado no Hub para ${phone}: ${err.message}`));

  notifyInboundNova({ phone, origem, ctwa }).catch(() => {});

  console.log(`✅ [inbound] conversa aberta com ${phone} (origem ${origem})`);
  return { ok: true };
}

/**
 * O agente ASSUME uma conversa que um humano já começou.
 *
 * Diferença para iniciarInbound: não manda mensagem nenhuma agora. Só prepara
 * o estado, para que a PRÓXIMA mensagem da lead seja conduzida normalmente.
 * Mandar boas-vindas por cima de uma conversa em andamento seria o contrário
 * do que a pessoa espera — ela já falou com gente.
 *
 * `contexto` é o que o humano já escreveu, para o agente não repetir a mesma
 * pergunta. Entra no histórico como fala do assistente, que é o que de fato foi.
 */
export async function assumirInbound({ phone, contexto = '', origem = 'direto' }) {
  if (!inboundAtivo()) return { ok: false, motivo: 'desligado' };
  if (await isBlocked(phone)) return { ok: false, motivo: 'bloqueado' };

  const eleg = await verificarElegibilidadeContatoSdr({
    phone, leadData: { nome: null, whatsapp: phone },
    source: `inbound_${origem}`, purpose: 'activation',
  }).catch(() => ({ allowed: true, reason: 'check indisponível' }));

  if (bloqueioDefinitivoSdr(eleg)) {
    return { ok: false, motivo: 'ja_paciente', detalhe: eleg.reason };
  }

  const ok = await setInboundMode(phone, {
    nome: null, whatsapp: phone, origem, ctwa: null, source: `inbound_${origem}`,
  });
  if (!ok) return { ok: false, motivo: 'bloqueado' };

  // Marca que a conversa já estava rolando: o agente não se reapresenta.
  await setInboundState(phone, { assumida: true, mensagensDoAgente: contexto ? 1 : 0 });
  if (contexto) await addMessage(phone, 'assistant', contexto).catch(() => {});

  // Confere o que FOI GRAVADO, não o que eu acho que gravei. A confirmação
  // para a Karina vale pelo que ela prova, e "assumi" sem checar o estado é
  // promessa, não prova.
  const salvo = await getInboundState(phone);
  const modoOk = await temConversaInbound(phone);
  const zapi = inboundConfigStatus();

  console.log(`🤝 [inbound] agente assumiu a conversa de ${phone} (origem ${origem})`);
  return {
    ok: true,
    diagnostico: {
      modoGravado: modoOk && salvo.assumida === true,
      envioConfigurado: zapi.configured,
      variaveisFaltando: zapi.missing,
      vinculoNoHub: eleg.hubContext,
      contextoNoHistorico: !!contexto,
    },
  };
}

/**
 * Conduz cada resposta da lead. Caminho próprio, interceptado antes da máquina
 * do SDR: score por formulário, branch Evelyn e oferta de Protocolo Raiz por
 * tier não se aplicam a quem chegou sem preencher nada.
 */
export async function conduzirInbound({ phone, mensagem, history = [] }) {
  if (!inboundAtivo()) {
    console.log(`[inbound] desligado — resposta de ${phone} ignorada`);
    return { ok: false, motivo: 'desligado' };
  }

  const estado = await getInboundState(phone);
  const leadData = (await getLeadData(phone)) || {};

  const r = await generateInboundReply({
    historico: history,
    mensagem,
    origem: estado.origem,
    nome: leadData.nome || '',
    qualificacao: estado.qualificacao,
    disponibilidade: estado.disponibilidade,
    mensagensDoAgente: estado.mensagensDoAgente || 0,
    assumida: estado.assumida === true,
  });

  // Estado apurado é salvo ANTES de qualquer envio: se o envio falhar, o que a
  // pessoa contou não se perde, e a próxima rodada não repete as perguntas.
  await setInboundState(phone, {
    qualificacao: r.qualificacao,
    disponibilidade: r.disponibilidade,
    score: r.score,
    tier: r.tier,
    etapa: r.etapa,
    mensagensDoAgente: (estado.mensagensDoAgente || 0) + (r.leadMessage ? 1 : 0),
  });
  if (r.nome && !leadData.nome) {
    await setInboundState(phone, { nome: r.nome });
  }

  const nome = r.nome || leadData.nome || estado.nome || null;
  const campos = camposParaOHub({
    nome, phone, origem: estado.origem,
    qualificacao: r.qualificacao, disponibilidade: r.disponibilidade,
    score: r.score, tier: r.tier,
  });

  // Red flag: acolhe em uma frase e para. Nenhuma oferta, nenhum produto.
  if (r.redflag) {
    if (r.leadMessage) {
      await sendInboundMessage(phone, r.leadMessage).catch(() => {});
      await addMessage(phone, 'assistant', r.leadMessage).catch(() => {});
    }
    await setHandedOff(phone);
    await notifyInbound({
      nome, phone, origem: estado.origem, motivo: 'pediu_humano',
      score: r.score, tier: r.tier, qualificacao: r.qualificacao,
      disponibilidade: r.disponibilidade, textoDaLead: mensagem,
      briefing: `🔴 SINAL DE SOFRIMENTO — atender com prioridade.\n${r.redflagMotivo || ''}`,
    }).catch(() => {});
    console.log(`🚨 [inbound] red flag em ${phone}`);
    return r;
  }

  // Falha técnica: não inventa resposta. Passa para a Karina com o contexto.
  if (!r.ok) {
    await setHandedOff(phone);
    await notifyInbound({
      nome, phone, origem: estado.origem, motivo: 'erro_tecnico',
      score: r.score, tier: r.tier, qualificacao: r.qualificacao,
      disponibilidade: r.disponibilidade, textoDaLead: mensagem,
      briefing: 'O agente não conseguiu gerar resposta válida. A lead está esperando.',
    }).catch(() => {});
    return r;
  }

  if (r.leadMessage) {
    await sendInboundMessage(phone, r.leadMessage);
    await addMessage(phone, 'assistant', r.leadMessage).catch(() => {});
  }

  if (r.handoff) {
    await setHandedOff(phone);
    await notifyInbound({
      nome, phone, origem: estado.origem, motivo: r.handoffMotivo,
      score: r.score, tier: r.tier, qualificacao: r.qualificacao,
      disponibilidade: r.disponibilidade, textoDaLead: mensagem,
      briefing: r.sdrBriefing,
    }).catch(err => console.error('[inbound] aviso para a Karina falhou:', err.message));

    // Só handoff de agendamento move o card para pré-consulta. "Pediu a
    // Evelyn" ou "fora do roteiro" não é lead pronta para a agenda, e mover o
    // card nesses casos sujaria a pipeline com pré-consulta que não existe.
    if (r.handoffMotivo === 'pronta_para_agendar') {
      migrarParaPreConsulta({
        leadData: campos,
        phone,
        turno: campos.disponibilidadeTexto,
        briefing: [
          r.sdrBriefing,
          campos.disponibilidadeTexto ? `Disponibilidade: ${campos.disponibilidadeTexto}` : null,
          'Lead do inbound WhatsApp. A Karina agenda a partir de outro número; a lead já foi avisada disso.',
        ].filter(Boolean).join('\n'),
      }).catch(err => console.error('[inbound] erro ao migrar card:', err.message));
    }

    console.log(`🟢 [inbound] handoff ${r.handoffMotivo} para ${phone}`);
    return r;
  }

  // Encerrou sozinha (não quis conversar): desativa para não ficar lead viva
  // esperando resposta que não vem.
  if (r.etapa === 'encerrada') {
    await deactivateLead(phone).catch(() => {});
    console.log(`[inbound] ${phone} encerrou a conversa`);
  }

  console.log(`[inbound] ${phone} → etapa ${r.etapa} · score ${r.score} · completa ${r.qualificacao.completa}`);
  return r;
}
