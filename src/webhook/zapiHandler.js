// src/webhook/zapiHandler.js

import { isActiveLead, isHandedOff, setHandedOff, blockPhone, unblockPhone, isBlocked, addMessage, getHistory, getLeadData, getSdrHistory, addSdrMessage, incrementTurn, getTurnCount, TURN_LIMIT, enqueueMessage, dequeueMessages, normalizePhone, deactivateLead, getConversationMode, getCommercialState, setCommercialState } from '../conversation/store.js';
import { aggregate } from '../conversation/aggregator.js';
import { cancelQuizCadence } from '../quizCadence.js';
import { generateReply, generateHandoffBriefing, generateConsultivo, generateFirstContact } from '../ai/anthropic.js';
import { conduzirConfirmacao } from '../confirmacao/handler.js';
import { conduzirOferta } from '../oferta/handler.js';
import { assumirInbound, retomarInbound } from '../inbound/handler.js';
import { sendMessage, notifySDR, notifySDRHandoff, notifySDRRetomada, notifySDRRedflag, notifySDRTurnLimit, notifyError, notifySDRManualReview, getSendErrorDetail } from '../zapi/sender.js';
import { handlePlanoCommand } from '../planos/handler.js';
import { getQuizPreData } from './quizPreHandler.js';
import { activateLead } from '../conversation/store.js';
import { garantirLeadCaptacaoNoHub, migrarParaPreConsulta, verificarElegibilidadeContatoSdr, bloqueioDefinitivoSdr, registrarEventoEvelyn } from '../hub/client.js';
import { evelynEligibility, validEvelynTransition } from '../evelyn/decision.js';
import { createEvelynJourney } from '../evelyn/journey.js';
import { scheduleEvelynJourney } from '../evelyn/delivery.js';
import crypto from 'crypto';
import { getParticipant, handleCampanhaReply } from '../campanha/handler.js';
import { config } from '../../config/index.js';

// Frase que ativa leads pós-quiz via WhatsApp direto
const FRASE_QUIZ = 'oi! fiz o quiz da table clinic e quero saber mais sobre os programas de acompanhamento';

function dentroDoHorario() {
  const agora = new Date();
  const brasilia = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const diaSemana = brasilia.getDay();
  const hora = brasilia.getHours();
  const fimDeSemana = diaSemana === 0 || diaSemana === 6;
  if (fimDeSemana) return hora >= 8 && hora < 17;
  return hora >= 8 && hora < 21;
}

export async function handleZapiMessage(req, res) {
  res.status(200).json({ ok: true });

  try {
    const body = req.body;
    if (body.type !== 'ReceivedCallback') return;

    const phone = normalizePhone(body.phone || '');
    // Legenda da imagem vem fora de body.text; sem isso, foto com texto junto
    // chegaria vazia.
    const messageText = body.text?.message || body.text || body.image?.caption || null;

    // Mídia recebida. Interessa à oferta: muita lead manda print do
    // comprovante, e conferir pagamento é trabalho humano. Serve também de
    // guarda para foto de corpo, exame ou remédio, que o agente não pode
    // comentar em hipótese nenhuma.
    const temImagem = !!(body.image || body.photo || body.sticker || body.document || body.video);

    if (!phone) return;
    if (body.isFromMe) return;

    // REAÇÃO NÃO É MENSAGEM. Um joinha no link da pré-consulta acordou o
    // agente e gerou resposta espontânea para uma lead em 14/10/2026.
    // Reação não pede resposta, não é pergunta e não é consentimento para
    // conversar — vale para TODOS os modos, sem exceção.
    // A checagem é larga de propósito: Z-API já mudou o formato desses eventos
    // mais de uma vez, e o custo de ignorar demais aqui é zero.
    const ehReacao = !!(body.reaction || body.reactionMessage || body.messageReaction)
      || String(body.type || '').toLowerCase().includes('reaction')
      || String(body.messageType || '').toLowerCase().includes('reaction');
    if (ehReacao) {
      console.log(`[zapi] reação ignorada de ${phone}`);
      return;
    }

    // Mensagem SÓ com mídia (sem texto nem legenda) era descartada aqui —
    // justamente o caso do print do comprovante. Agora passa, mas apenas no
    // modo oferta: nos outros fluxos segue ignorada, como sempre foi.
    if (!messageText && temImagem) {
      const modoMidia = await getConversationMode(phone);
      if (modoMidia !== 'oferta') return;
      const leadMidia = (await getLeadData(phone)) || {};
      const histMidia = await getHistory(phone).catch(() => []);
      await conduzirOferta({
        phone, leadData: leadMidia, history: histMidia,
        mensagem: '[imagem enviada pela lead]', temImagem: true,
      });
      return;
    }

    if (!messageText) return;

    // Mensagem da Karina
    if (ehNumeroDaEquipe(phone)) {
      const trimmed = messageText.trim();
      if (trimmed.toLowerCase().startsWith('/unstop')) {
        const targetPhone = normalizePhone(trimmed.slice(7).trim());
        if (!targetPhone) {
          await avisaKarina('Uso: /unstop 5511999999999');
          return;
        }
        await unblockPhone(targetPhone);
        await avisaKarina(`🔓 Lead ${targetPhone} desbloqueada — a automação pode voltar a contatá-la.`);
        return;
      }
      if (trimmed.toLowerCase().startsWith('/stop')) {
        const targetPhone = normalizePhone(trimmed.slice(5).trim());
        if (!targetPhone) {
          await avisaKarina('Uso: /stop 5511999999999');
          return;
        }
        // Bloquear o próprio número da SDR silenciaria todas as notificações.
        if (ehNumeroDaEquipe(targetPhone)) {
          await avisaKarina('⚠️ Não dá para bloquear um número da equipe — isso silenciaria as notificações.');
          return;
        }
        // handedOff silencia a conversa atual; blockPhone impede que qualquer
        // novo gatilho (quiz, formulário, recuperação de checkout, disparo)
        // reative o número mais tarde.
        await setHandedOff(targetPhone);
        await blockPhone(targetPhone);
        await avisaKarina(`✅ Lead ${targetPhone} desativada e bloqueada. Use /unstop ${targetPhone} para reverter.`);
        return;
      }
      // /agente <telefone> [| o que você já escreveu]
      // O agente assume uma conversa do número do inbound que um humano
      // começou. Não manda nada agora: a próxima mensagem da lead é que
      // passa a ser conduzida por ele.
      if (trimmed.toLowerCase().startsWith('/agente')) {
        const resto = trimmed.slice(7).trim();
        const [alvoRaw, ...ctx] = resto.split('|');
        const alvo = normalizePhone((alvoRaw || '').trim());
        if (!alvo) {
          await avisaKarina('Uso: /agente 5511999999999\nOu, para o agente saber o que você já disse:\n/agente 5511999999999 | texto que você mandou');
          return;
        }
        const r = await assumirInbound({ phone: alvo, contexto: ctx.join('|').trim() });
        if (r.ok) {
          const d = r.diagnostico || {};
          const linhas = [
            `🤝 *Agente assumiu ${alvo}*`,
            ``,
            `${d.modoGravado ? '✅' : '❌'} Conversa gravada em modo inbound`,
            `${d.envioConfigurado ? '✅' : '❌'} Instância de envio configurada${d.envioConfigurado ? '' : ` (falta: ${(d.variaveisFaltando || []).join(', ')})`}`,
            `${d.contextoNoHistorico ? '✅' : '⚠️'} ${d.contextoNoHistorico ? 'Sua mensagem está no histórico dele' : 'Sem contexto: ele pode repetir sua pergunta'}`,
            `${d.vinculoNoHub === false ? '✅' : d.vinculoNoHub === true ? 'ℹ️' : '⚠️'} ${d.vinculoNoHub === false ? 'Lead nova, sem vínculo no Hub' : d.vinculoNoHub === true ? 'Já tem vínculo no Hub' : 'Hub não respondeu o vínculo'}`,
            ``,
            d.modoGravado && d.envioConfigurado
              ? `Ele NÃO manda nada agora. Na próxima mensagem dela, responde sem se reapresentar, qualifica e te chama quando tiver turno e dias.`
              : `⚠️ Algo acima falhou: ele NÃO vai responder. Siga na mão.`,
          ];
          await avisaKarina(linhas.join('\n'));
        } else {
          const motivo = {
            desligado:   'o inbound está desligado no código',
            bloqueado:   'esse número está bloqueado (/unstop para liberar)',
            ja_paciente: `já tem vínculo no Hub (${r.detalhe || 'paciente ou venda'}) — atenda na mão`,
          }[r.motivo] || r.motivo;
          await avisaKarina(`⚠️ Não assumi ${alvo}: ${motivo}.`);
        }
        return;
      }
      // /retomar <telefone> [| o que ela mandou]
      // Diferente do /agente: este MANDA a mensagem agora, reconhecendo o
      // atraso. É para quem escreveu, não foi respondida e ficou quieta —
      // /agente só prepara e espera, e quem ficou quieta não escreve de novo.
      if (trimmed.toLowerCase().startsWith('/retomar')) {
        const resto = trimmed.slice(8).trim();
        const [alvoRaw, ...ctx] = resto.split('|');
        const alvo = normalizePhone((alvoRaw || '').trim());
        if (!alvo) {
          await avisaKarina('Uso: /retomar 5511999999999\nMelhor ainda, com o que ela mandou:\n/retomar 5511999999999 | oi');
          return;
        }
        await avisaKarina(`⏳ Retomando ${alvo}...`);
        const r = await retomarInbound({ phone: alvo, mensagemDela: ctx.join('|').trim() });
        if (r.ok) {
          await avisaKarina(`✅ *Retomada enviada para ${alvo}*\n\n💬 "${r.mensagemEnviada}"\n\nA conversa está com o agente. Ele qualifica e te chama quando tiver turno e dias.`);
        } else {
          const motivo = {
            desligado:     'o inbound está desligado no código',
            bloqueado:     'esse número está bloqueado (/unstop para liberar)',
            ja_paciente:   'já tem vínculo definitivo no Hub — atenda na mão',
            erro_geracao:  'a IA não gerou a mensagem; tente de novo',
          }[r.motivo] || r.motivo;
          await avisaKarina(`⚠️ Não retomei ${alvo}: ${motivo}.`);
        }
        return;
      }
      if (trimmed.toLowerCase().startsWith('/plano')) {
        await handlePlanoCommand(trimmed.slice(6).trim());
        return;
      }
      await handleSdrConsultivo(trimmed);
      return;
    }

    // Bloqueio permanente tem prioridade sobre tudo: nem campanha, nem frase do
    // quiz, nem lead ativa fazem o agente responder um número bloqueado.
    if (await isBlocked(phone)) {
      console.log(`⛔ Mensagem ignorada de ${phone} (número bloqueado)`);
      return;
    }

    // Lead respondeu: a régua fria D+1/D+3 não faz mais sentido, quem
    // conduz daqui em diante é a conversa.
    cancelQuizCadence(phone, 'respondeu').catch(err =>
      console.warn(`[quiz-cadence] cancelamento por resposta falhou: ${err.message}`));

    // Resposta a campanha sazonal (ex.: Lista VIP Evelyn Liu) tem prioridade:
    // interrompe qualquer automação para este número e nunca cai no fluxo do
    // agente SDR nem na ativação por frase de quiz.
    const campanhaParticipant = await getParticipant(phone);
    if (campanhaParticipant) {
      console.log(`🤍 Resposta de participante de campanha: ${phone}`);
      await handleCampanhaReply(phone, messageText, campanhaParticipant);
      return;
    }

    // Verifica frase de ativação pós-quiz
    if (messageText.trim().toLowerCase() === FRASE_QUIZ) {
      console.log(`🎯 Frase quiz detectada de ${phone}`);
      await handleQuizActivation(phone);
      return;
    }

    if (!await isActiveLead(phone)) {
      console.log(`⏭️  Mensagem ignorada de ${phone} (não é lead ativo)`);
      return;
    }

    if (await isHandedOff(phone)) {
      console.log(`⏭️  Mensagem ignorada de ${phone} (handoff ativo)`);
      return;
    }

    if (!dentroDoHorario()) {
      console.log(`⏰ Fora do horário — enfileirando mensagem de ${phone}`);
      await enqueueMessage(phone, messageText);
      return;
    }

    console.log(`📨 Mensagem de lead ativo ${phone}`);
    aggregate(phone, messageText, processAggregatedMessages);

  } catch (err) {
    console.error('❌ Erro no handler da Zapi:', err.message);
  }
}

// Números da equipe: aceitam comando (/stop, /agente, /plano) e caem no modo
// consultivo. É a MESMA lista que o sender já blinda contra bloqueio e para
// quem já manda todo handoff, red flag e erro — dar comando a quem já recebe
// tudo é coerente; manter só o SDR_PHONE era inconsistência, não segurança.
function ehNumeroDaEquipe(phone) {
  const alvo = normalizePhone(String(phone || ''));
  return [config.sdr.phone, process.env.NUMERO_BACKUP]
    .filter(Boolean)
    .some(p => normalizePhone(String(p)) === alvo);
}

function avisaKarina(texto) {
  return sendMessage(config.sdr.phone, texto, { skipDelay: true });
}

async function handleQuizActivation(phone) {
  try {
    // Busca dados do quiz armazenados no Redis
    const quizData = await getQuizPreData(phone);

    let leadData;

    if (quizData) {
      console.log(`📦 Dados do quiz encontrados para ${phone}`);
      leadData = {
        ...quizData,
        source: 'quiz_botao_whatsapp',
      };
    } else {
      // Sem dados do quiz — ativa com perfil mínimo e conduz investigação
      console.log(`⚠️  Sem dados do quiz para ${phone} — ativando com perfil mínimo`);
      leadData = {
        nome: 'você',
        whatsapp: phone,
        whats: phone,
        source: 'quiz_botao_whatsapp',
        temperatura: 'warm',
        score: 5,
        qualificacao: { tier: 'warm', score: 5 },
        historico: [],
        respostas: [],
      };
    }

    // Só o veto definitivo do Hub (paciente/convertido) impede a ativação;
    // check indisponível ou lead sem card não bloqueia (fail-open).
    const eligibility = await verificarElegibilidadeContatoSdr({ phone, leadData, source: 'quiz_botao_whatsapp', purpose: 'activation' });
    if (bloqueioDefinitivoSdr(eligibility)) {
      console.warn(`🛑 Ativação pós-quiz bloqueada para ${phone}: ${eligibility.reason}`);
      await deactivateLead(phone);
      return;
    }

    // Card no CRM é bookkeeping: não condiciona a ativação.
    garantirLeadCaptacaoNoHub({
      leadData: { ...leadData, source: leadData.source || 'captacao_sdr' },
      phone,
    }).catch(err => {
      console.warn(`⚠️ Card de captação não criado no Hub para ${phone}: ${err.message}`);
    });

    const result = await generateFirstContact(leadData);

    leadData._monitorarDePerto = result.orientacao?.monitorarDePerto || false;
    leadData._avisoNatalia = result.avisoNatalia || false;

    await activateLead(phone, leadData);
    await addMessage(phone, 'assistant', result.leadMessage);

    if (!dentroDoHorario()) {
      await enqueueMessage(phone, `__PRIMEIRA_MENSAGEM__${result.leadMessage}`);
      await notifySDR(leadData, result.sdrBriefing);
      return;
    }

    await sendMessage(phone, result.leadMessage);
    await notifySDR(leadData, result.sdrBriefing);

    console.log(`✅ Lead pós-quiz ativada: ${phone}`);
  } catch (err) {
    console.error(`❌ Erro ao ativar lead pós-quiz ${phone}:`, err.message);
  }
}

export async function processQueue(phone) {
  const messages = await dequeueMessages(phone);
  if (!messages.length) return;

  console.log(`📬 Processando fila de ${phone}: ${messages.length} mensagens`);

  const primeiraMsg = messages.find(m => m.startsWith('__PRIMEIRA_MENSAGEM__'));
  const respostas = messages.filter(m => !m.startsWith('__PRIMEIRA_MENSAGEM__'));

  if (primeiraMsg) {
    const texto = primeiraMsg.replace('__PRIMEIRA_MENSAGEM__', '');
    await sendMessage(phone, texto);
  }

  if (respostas.length) {
    const combined = respostas.join('\n');
    await processAggregatedMessages(phone, combined);
  }
}

async function handleSdrConsultivo(pergunta) {
  try {
    const historico = getSdrHistory();
    addSdrMessage('user', pergunta);
    const resposta = await generateConsultivo(pergunta, historico);
    addSdrMessage('assistant', resposta);
    await sendMessage(config.sdr.phone, resposta, { skipDelay: true });
  } catch (err) {
    console.error('❌ Erro no modo consultivo:', err.message);
  }
}

async function processAggregatedMessages(phone, combinedMessage) {
  console.log(`⚡ Processando mensagens de ${phone}`);

  try {
    const history = await getHistory(phone);
    const leadData = await getLeadData(phone);
    // Bloqueia a resposta automática apenas com veto definitivo do Hub
    // (paciente ou venda concluída); indisponibilidade não silencia o agente.
    const eligibility = await verificarElegibilidadeContatoSdr({ phone, leadData, source: 'sdr_reply' });
    if (bloqueioDefinitivoSdr(eligibility)) {
      console.warn(`🛑 Resposta automática bloqueada para ${phone}: ${eligibility.reason}`);
      await deactivateLead(phone);
      if (eligibility.patient) {
        await sendMessage(
          config.sdr.phone,
          `⚠️ Automação SDR bloqueada para paciente: ${eligibility.patient.name || phone} (${phone}).`,
          { skipDelay: true }
        );
      }
      return;
    }
    if (!eligibility.allowed) {
      console.warn(`⚠️ Elegibilidade inconclusiva para ${phone} — respondendo mesmo assim: ${eligibility.reason}`);
    }

    await addMessage(phone, 'user', combinedMessage);
    await incrementTurn(phone);

    const turns = await getTurnCount(phone);
    console.log(`🔢 Turno ${turns}/${TURN_LIMIT} para ${phone}`);

    if (turns >= TURN_LIMIT) {
      console.log(`🛑 Teto de turnos atingido para ${phone}`);
      await setHandedOff(phone);
      const briefing = await generateHandoffBriefing(leadData, await getHistory(phone), 'não informado');
      await notifySDRTurnLimit(leadData, briefing);
      return;
    }

    const mode = await getConversationMode(phone);

    // Confirmação de pré-consulta tem caminho próprio e curto: pergunta, lê a
    // resposta, move o card. Intercepta ANTES da máquina do SDR de propósito —
    // qualificação, score, branch Evelyn e handoff de agendamento não têm o que
    // fazer numa conversa que é só "você vem amanhã?", e arrastá-los para cá é
    // que quebraria o fluxo que já funciona.
    if (mode === 'confirmacao') {
      await conduzirConfirmacao({ phone, leadData, history, mensagem: combinedMessage });
      return;
    }

    // Oferta pós pré-consulta: mesmo motivo da interceptação acima. Esta
    // pessoa já foi qualificada por uma nutricionista numa consulta de
    // verdade; rodar score e branch Evelyn por cima disso seria recomeçar do
    // zero uma conversa que já está adiantada.
    if (mode === 'oferta') {
      // temImagem vivia no escopo de handleZapiMessage: referenciar aqui era
      // ReferenceError garantido em toda resposta de texto no modo oferta.
      // Imagem sem texto já é tratada antes da agregação, no próprio webhook.
      await conduzirOferta({ phone, leadData, history, mensagem: combinedMessage, temImagem: false });
      return;
    }

    const commercial=await getCommercialState(phone);
    const evelyn={...evelynEligibility({phone,source:leadData.source,message:combinedMessage,history,leadData}),stage:commercial.stage||'candidate'};
    if(evelyn.considered&&!commercial.consideredAt){await setCommercialState(phone,{consideredAt:new Date().toISOString(),signals:evelyn.signals,stage:evelyn.eligible?'candidate':'not_offered'});await registrarEventoEvelyn({eventId:crypto.randomUUID(),eventType:evelyn.eligible?'evelyn_candidate':'evelyn_not_offered',phone,leadData,payload:{reason:evelyn.reason,signals:evelyn.signals,explicit_intent:true,decision:evelyn.eligible?'considering':'not_offered'}});}
    const result = await generateReply(phone, combinedMessage, history, leadData, mode, evelyn);

    if(!evelyn.eligible)result.evelynEvent='';
    // O acompanhamento direto não é um handoff de pré-consulta Table.
    if(evelyn.eligible&&result.evelynEvent!=='evelyn_routed_to_table')result.handoff=false;
    if(result.evelynEvent&&validEvelynTransition(evelyn.stage,result.evelynEvent)){
      const stage=result.evelynEvent.replace(/^evelyn_/,'');
      await setCommercialState(phone,{branch:result.evelynEvent==='evelyn_routed_to_table'?'table':'evelyn',stage,signals:evelyn.signals});
      await registrarEventoEvelyn({eventId:crypto.randomUUID(),eventType:result.evelynEvent,phone,leadData,payload:{reason:evelyn.reason,signals:evelyn.signals,explicit_intent:true,price_response:stage.includes('accepted')?'accepted':stage.includes('declined')?'declined':null}});
      if(result.evelynEvent==='evelyn_price_accepted'&&!commercial.journeyUrl){
        try{const journey=await createEvelynJourney({phone,leadData,history:[...history,{role:'user',content:combinedMessage}]});await scheduleEvelynJourney({phone,leadData,journey});result.leadMessage=`Perfeito${leadData.nome?`, ${String(leadData.nome).split(' ')[0]}`:''}. A partir do que você compartilhou, vou preparar junto com a equipe uma apresentação personalizada da sua Jornada com a Evelyn. Em até 30 minutos eu te envio por aqui.`;await setCommercialState(phone,{stage:'journey_prepared',journeyUrl:journey.url});await registrarEventoEvelyn({eventId:crypto.randomUUID(),eventType:'evelyn_journey_generated',phone,leadData,payload:{journey_url:journey.url,signals:evelyn.signals,baseline:journey.baseline,objective_90_days:journey.objective90Days}});}catch(err){console.error('[evelyn] jornada falhou, fluxo segue:',err.message);}
      }
      if(result.evelynEvent==='evelyn_routed_to_table')migrarParaPreConsulta({leadData,phone,turno:null,briefing:'Lead retornou naturalmente do branch Evelyn para avaliação pela pré-consulta Table.'}).catch(()=>{});
    }

    if (result.needsManualReview) {
      console.warn(`⚠️ Pausando ${phone} para revisão manual após respostas inválidas da IA`);
      await sendMessage(phone, result.leadMessage);
      await addMessage(phone, 'assistant', result.leadMessage);
      await setHandedOff(phone);
      await notifySDRManualReview(phone, result.sdrBriefing);
      return;
    }

    if (result.redflag) {
      console.log(`🚨 Red flag detectado para ${phone}`);
      await setHandedOff(phone);
      await notifySDRRedflag(leadData, result.redflagMotivo);
      return;
    }

    if (result.handoff) {
      await sendMessage(phone, result.leadMessage);
      await addMessage(phone, 'assistant', result.leadMessage);
      await setHandedOff(phone);
      const handoffBriefing = await generateHandoffBriefing(leadData, await getHistory(phone), result.handoffTurno);

      // Retomada é sinalizada diferente e NÃO migra card: essa lead já tem card
      // de pré-consulta no Hub. O que a Karina precisa é assumir a conversa com
      // o contexto, não um card novo.
      if (mode === 'reativacao') {
        console.log(`🔁 Retomada — handoff para a Karina: ${phone}`);
        await notifySDRRetomada(leadData, handoffBriefing, leadData.reativacao || {});
        return;
      }

      console.log(`🟢 Handoff ativado para ${phone}`);
      await notifySDRHandoff(leadData, result.handoffTurno, handoffBriefing);
      // Migra o card de captação para pré-consulta / "A Agendar" no Hub (igual ao Protocolo Raiz).
      // Fire-and-forget: nunca deve bloquear nem quebrar o handoff para a Karina.
      migrarParaPreConsulta({ leadData, phone, turno: result.handoffTurno, briefing: handoffBriefing })
        .catch(err => console.error('[hub] erro ao migrar card no handoff:', err.message));
      return;
    }

    await sendMessage(phone, result.leadMessage);
    await addMessage(phone, 'assistant', result.leadMessage);

  } catch (err) {
    console.error(`❌ Erro ao processar resposta para ${phone}:`, err.message);
    await notifyError(phone, getSendErrorDetail(err));
  }
}
