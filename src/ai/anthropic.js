// src/ai/anthropic.js

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from '../../config/index.js';
import {
  anthropicText,
  manualReviewFallback,
  parseGeneratedReply,
  sanitizeConversationHistory,
} from './replyResult.js';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(
  join(__dirname, '../../config/prompts/sdr.txt'),
  'utf-8'
);

const CONSULTIVO_PROMPT = readFileSync(
  join(__dirname, '../../config/prompts/consultivo.txt'),
  'utf-8'
);

const RECUPERACAO_PROMPT = readFileSync(
  join(__dirname, '../../config/prompts/recuperacao-checkout.txt'),
  'utf-8'
);

const REATIVACAO_PROMPT = readFileSync(
  join(__dirname, '../../config/prompts/reativacao.txt'),
  'utf-8'
);

const OFERTA_PROMPT = readFileSync(
  join(__dirname, '../../config/prompts/oferta.txt'),
  'utf-8'
);

const CONFIRMACAO_PROMPT = readFileSync(
  join(__dirname, '../../config/prompts/confirmacao.txt'),
  'utf-8'
);

// Contexto comum das mensagens de oferta. O que a nutricionista escreveu e o
// que a pessoa respondeu no quiz sao o que permite continuar a conversa dela
// em vez de recomecar um pitch — e e o que separa isto de um template.
function contextoOferta(d = {}) {
  const partes = [
    `Nome: ${d.nome || 'nao informado'}`,
    `Nutricionista que atendeu: ${d.nutri || 'nao informada'}`,
    `Produto recomendado por ela: ${d.produto || 'nao informado'}`,
    // A jornada e o link que a lead JA TEM, desde a confirmacao da
    // pre-consulta, e agora ela carrega a oferta dentro. E esse que vai na
    // mensagem: mandar um link cru de checkout desperdicaria o documento que
    // foi feito para ela e obrigaria a escolher qual abrir.
    d.jornada_url ? `Jornada dela, JA ATUALIZADA com o acompanhamento indicado: ${d.jornada_url}` : null,
    !d.jornada_url && d.oferta_url ? `Link da oferta (use so porque nao ha jornada): ${d.oferta_url}` : null,
    d.perfil ? `Padrao do Protocolo Raiz: ${d.perfil}` : null,
    d.veio_do_pr ? 'Ela ja comprou o Protocolo Raiz antes.' : 'Ela entrou direto na pre-consulta, sem passar pelo Protocolo Raiz.',
    d.obs_form ? `\nO que ela trouxe no formulario da pre-consulta:\n${String(d.obs_form).slice(0, 1500)}` : null,
    d.obs_nutri ? `\nObservacoes da nutricionista:\n${String(d.obs_nutri).slice(0, 1500)}` : null,
    d.respostas ? `\nO que ela respondeu no quiz:\n${String(d.respostas).slice(0, 1000)}` : null,
  ].filter(Boolean);
  return partes.join('\n');
}

// O que cada toque da regua deve fazer. Explicito no prompt porque a diferenca
// entre eles e justamente o que impede a regua de virar quatro cobrancas.
const INSTRUCAO_POR_TOQUE = {
  0: `Primeira mensagem. Retome ALGO CONCRETO que ela trouxe na consulta e diga o que a nutricionista recomendou e por que. Diga que a jornada DELA foi atualizada agora com esse acompanhamento, e REENVIE o link da jornada para facilitar o acesso. Tres a cinco linhas.`,
  1: `Ela nao respondeu a primeira mensagem. NAO repita a oferta e NAO mande o link de novo. Faca UMA pergunta que abra espaco para o nao: o que pesou, o que ficou faltando. Duas linhas.`,
  3: `Ela segue sem responder. Traga um ANGULO NOVO, usando algo especifico do que ela contou na consulta ou no quiz. Nao cobre, nao pergunte "viu minha mensagem". Tres linhas no maximo.`,
  7: `Ultimo contato. ENCERRE de forma explicita e sem culpa: diga que vai deixar por aqui e que se ela mudar de ideia e so chamar. Nao faca pergunta, nao mande link, nao deixe gancho. Duas linhas.`,
};

/**
 * Mensagem de um toque da regua de oferta. Texto puro: e ela que fala primeiro.
 */
export async function generateOfertaMessage(dados = {}) {
  const toque = Number(dados.toque) || 0;
  const resposta = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 900,
    system: OFERTA_PROMPT,
    messages: [{ role: 'user', content: `
Escreva APENAS a mensagem, em texto puro (sem JSON, sem aspas em volta).

${contextoOferta(dados)}

${INSTRUCAO_POR_TOQUE[toque] || INSTRUCAO_POR_TOQUE[0]}` }],
  });
  return (resposta.content[0]?.text || '').trim();
}

/**
 * Resposta da lead na oferta. Devolve a mensagem E o que alimenta o registro:
 * desfecho, objecao classificada e motivo de handoff.
 *
 * Qualquer coisa que nao seja JSON valido vira handoff. Num funil de saude,
 * agente confuso falando sozinho e pior do que agente calado.
 */
export async function generateOfertaReply({ dados = {}, historico = [], mensagem, temImagem = false }) {
  // Imagem nao passa pela LLM: comprovante e trabalho humano, e foto de corpo,
  // exame ou remedio e exatamente o que o agente nao pode comentar.
  if (temImagem) {
    return {
      mensagem: 'Recebi! Vou confirmar aqui com a equipe e já te retorno, tá?',
      handoff: true,
      handoff_motivo: 'comprovante',
      desfecho: 'em_andamento',
      objecao: null,
    };
  }

  const resposta = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1200,
    system: OFERTA_PROMPT,
    messages: [
      ...sanitizeConversationHistory(historico),
      { role: 'user', content: `
${contextoOferta(dados)}

Mensagem dela agora: "${mensagem}"

Responda no formato JSON definido.` },
    ],
  });

  const bruto = (resposta.content[0]?.text || '').replace(/```json|```/g, '').trim();
  try {
    const p = JSON.parse(bruto);
    const desfechos = ['fechou', 'nao_fechou', 'em_andamento'];
    const motivos = ['nao_sabia', 'comprovante', 'sofrimento', 'pedido_da_lead', 'outro'];
    const desfecho = desfechos.includes(p.desfecho) ? p.desfecho : 'em_andamento';
    const motivo = motivos.includes(p.handoff_motivo) ? p.handoff_motivo : null;
    return {
      mensagem: String(p.mensagem || '').trim(),
      handoff: p.handoff === true || !!motivo || desfecho === 'fechou',
      handoff_motivo: motivo || (desfecho === 'fechou' ? 'comprovante' : null),
      desfecho,
      objecao: typeof p.objecao === 'string' && p.objecao !== 'null' ? p.objecao : null,
    };
  } catch {
    console.error('[oferta] IA nao devolveu JSON valido:', bruto.slice(0, 200));
    return {
      mensagem: '', handoff: true, handoff_motivo: 'outro',
      desfecho: 'em_andamento', objecao: null,
    };
  }
}

/**
 * Primeira mensagem da confirmacao de pre-consulta. Texto puro: e ela que abre
 * a conversa. As respostas seguintes sao conduzidas pelo mesmo prompt, em
 * generateReply com mode 'confirmacao'.
 */
export async function generateConfirmacaoMessage({ nome, quando, nutri, jornadaUrl }) {
  const resposta = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 400,
    system: CONFIRMACAO_PROMPT,
    messages: [{ role: 'user', content: `
Escreva APENAS a primeira mensagem, em texto puro (sem JSON).

Nome: ${nome || 'nao informado'}
Pre-consulta: ${quando || 'amanha'}
Nutricionista: ${nutri || 'nossa nutricionista'}
${jornadaUrl ? `Jornada preparada para ela: ${jornadaUrl}` : ''}

Cumprimente pelo primeiro nome, diga quando e a pre-consulta e pergunte se ela
confirma a presenca. Duas a tres linhas no maximo.${jornadaUrl ? `

Mande TAMBEM o link da jornada, dizendo em uma frase que foi preparado para
ela a partir do que contou. Ver que alguem preparou algo e o que faz a pessoa
aparecer. Nao descreva o conteudo, so convide a dar uma olhada.` : ''}` }],
  });
  return resposta.content[0].text.trim();
}

/**
 * Le a resposta da lead na confirmacao. Devolve a mensagem de volta E a
 * classificacao que decide o movimento do card no Hub.
 *
 * Classificacao desconhecida vira 'indefinido' com handoff: na duvida, quem
 * decide e uma pessoa. Confirmar errado custa uma agenda vazia; mandar para a
 * Karina custa um minuto dela.
 */
export async function generateConfirmacaoReply({ nome, quando, nutri, historico = [], mensagem }) {
  const resposta = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: CONFIRMACAO_PROMPT,
    messages: [
      ...sanitizeConversationHistory(historico),
      { role: 'user', content: `
Nome: ${nome || 'nao informado'}
Pre-consulta: ${quando || 'amanha'}
Nutricionista: ${nutri || 'nossa nutricionista'}

Mensagem da pessoa: "${mensagem}"

Responda no formato JSON definido.` },
    ],
  });
  const bruto = resposta.content[0].text.replace(/```json|```/g, '').trim();
  try {
    const p = JSON.parse(bruto);
    const classificacoes = ['confirmou', 'nao_pode', 'indefinido'];
    const classificacao = classificacoes.includes(p.classificacao) ? p.classificacao : 'indefinido';
    return {
      mensagem: String(p.mensagem || '').trim(),
      classificacao,
      handoff: p.handoff === true || classificacao === 'indefinido',
    };
  } catch {
    console.error('[confirmacao] IA nao devolveu JSON valido:', bruto.slice(0, 200));
    return { mensagem: '', classificacao: 'indefinido', handoff: true };
  }
}

// Gera a mensagem humanizada de recuperação de checkout (Karina). Retorna TEXTO
// puro (não JSON) — é a 1ª mensagem que abre a conversa. Respostas subsequentes
// da lead são conduzidas pelo mesmo RECUPERACAO_PROMPT no fluxo do agente.
export async function generateRecoveryMessage(payload) {
  const { name, stage, touch, pix_code, pix_expiration, checkout_url, perfil, respostas } = payload || {};
  const temPix = stage === 'waiting_payment' && pix_code;

  // As respostas do quiz são o que separa esta mensagem de um template. A
  // pessoa contou o que acontece com ela; a mensagem tem de mostrar que
  // alguém leu. Sem elas o agente ainda escreve, só genérico.
  const contexto = String(respostas || '').trim();

  const userPrompt = `
Contexto da recuperação de checkout (gere APENAS a mensagem de WhatsApp, texto puro,
sem aspas e sem explicação):

Nome: ${name || 'não informado'}
Situação: ${temPix ? 'gerou o pix e ainda não pagou' : 'abriu o checkout e não finalizou (sem pix gerado)'}
Toque: ${touch === 2 ? '2 (o pix está perto de expirar — reforce com gentileza que a validade é curta e ofereça o link/pix de novo)' : '1 (primeiro contato)'}
Perfil emocional: ${perfil || 'não informado'}
Link do checkout: ${checkout_url || 'não informado'}
${temPix ? `Pix copia-e-cola: ${pix_code}` : ''}
${temPix && pix_expiration ? `O pix expira em: ${pix_expiration}` : ''}

${contexto ? `O que ela respondeu no quiz:
${contexto.slice(0, 1200)}

Use UMA coisa concreta do que ela respondeu para mostrar que você leu. Não liste
as respostas, não repita como relatório, não diagnostique e não dê conselho sobre
alimentação. É um fio de conexão, não um resumo.` : 'Ela não passou pelo quiz, ou as respostas não chegaram: escreva sem inventar nada sobre a história dela.'}

Regras da mensagem: curta, calorosa, uma pergunta só, sem parecer robô. ${temPix ? 'Inclua o link do checkout e o pix copia-e-cola.' : 'Inclua o link do checkout e pergunte se ficou alguma dúvida.'}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 800,
    system: RECUPERACAO_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return (response.content[0]?.text || '').trim();
}

// Primeira mensagem da reativação. Texto puro (não JSON): é ela que abre a
// conversa. As respostas seguintes são conduzidas pelo MESMO REATIVACAO_PROMPT
// dentro do fluxo normal do agente, via conv.mode='reativacao'.
//
// O contexto do Hub (score, persona, briefing) entra aqui para ORIENTAR a
// pergunta de abertura — nunca para ser recitado à lead. O prompt é explícito
// sobre isso; este comentário existe para quem for mexer depois não afrouxar.
export async function generateReactivationMessage(payload) {
  const {
    nome, persona, briefing, ultimoContato, motivoPerda,
    icpScore, recomendacao,
  } = payload || {};

  const userPrompt = `
Gere APENAS a primeira mensagem de WhatsApp (texto puro, sem aspas, sem explicação).

Nome: ${nome || 'não informado'}
Última conversa com a equipe: ${ultimoContato || 'não informado'}
Persona provável: ${persona || 'não identificada'}
${motivoPerda ? `Motivo registrado na época: ${motivoPerda}` : ''}
${briefing ? `Contexto interno (NÃO repetir para ela): ${briefing}` : ''}
${icpScore != null ? `Fit interno: ${icpScore}/100${recomendacao ? ` — hipótese de entrega: ${recomendacao}` : ''}` : ''}

A mensagem deve: cumprimentar pelo nome, lembrar com leveza que já se falaram (SEM
detalhar o que ela contou), e fazer UMA pergunta aberta sobre como ela está agora.
Curta, calorosa, sem cobrança e sem mencionar que ela "não fechou".`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: REATIVACAO_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  return (response.content[0]?.text || '').trim();
}

export async function generateFirstContact(leadData) {
  const {
    nome, whatsapp, whats, temperatura, score,
    oqueMaisPesa, dores, historico, saude,
    comprometimento, maiorDificuldade, dificuldade, source,
    qualificacao
  } = leadData;

  const scoreVal = qualificacao?.score ?? score ?? '?';
  const tierVal = qualificacao?.tier || temperatura || '?';

  const userPrompt = `
🚨 Novo lead recebido

Nome: ${nome}
WhatsApp: ${whatsapp || whats}
Temperatura: ${tierVal}
Score: ${scoreVal}/10
O que mais pesa: ${oqueMaisPesa || dores || 'não informado'}
Histórico: ${Array.isArray(historico) ? historico.join(', ') : historico || 'não informado'}
Saúde: ${Array.isArray(saude) ? saude.join(', ') : saude || 'não informado'}
Comprometimento: ${comprometimento}/5
Maior dificuldade: ${maiorDificuldade || dificuldade || 'não informado'}
Source: ${source || 'não informado'}
Data: ${new Date().toISOString()}

Responda APENAS em JSON válido. Sem texto antes ou depois. Sem blocos de código.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].text;

  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    console.error('IA não retornou JSON válido:', text);
    return {
      tier: 'warm',
      tierJustificativa: 'Erro ao processar.',
      leadMessage: `Oi ${nome}! Aqui é a Karina, da equipe da Evelyn Liu. Vi as respostas que você preencheu recentemente e queria conversar sobre o que você compartilhou. Posso te fazer uma pergunta?`,
      sdrBriefing: 'Erro ao gerar briefing. Avalie manualmente.',
      orientacao: { objetivo: '', tom: 'Acolhedor', gancho: '', proximoPasso: '', monitorarDePerto: false },
      followUp24h: `Oi ${nome}, passando para saber se recebeu minha mensagem.`,
      followUp48h: `${nome}, ainda penso no que você compartilhou. Quando quiser conversar, estou aqui.`,
      avisoNatalia: false,
      handoff: false,
      redflag: false,
      redflagMotivo: '',
    };
  }
}

export async function generateFollowUpContact(leadData) {
  const {
    nome, whatsapp, whats, temperatura, score,
    oqueMaisPesa, dores, historico, saude,
    comprometimento, maiorDificuldade, dificuldade, source,
    qualificacao
  } = leadData;

  const scoreVal = qualificacao?.score ?? score ?? '?';
  const tierVal = qualificacao?.tier || temperatura || '?';

  const userPrompt = `
🔁 Follow-up 6h — retomada de contato com lead que fez o quiz

CONTEXTO: esta lead fez o quiz e, cerca de 15 minutos depois, recebeu um
material com o resultado dela. Agora, ~6h depois, você está retomando o
contato. NÃO é um primeiro contato do zero.

ESTA MENSAGEM NÃO É SOBRE O DOSSIÊ. Não cobre leitura, não pergunte se ela
viu o material, não fique em cima dele. O objetivo é abrir espaço para ela
perceber que pode precisar de algo ALÉM de um protocolo: sinalizar, de forma
leve e genuína, que existem outras formas de ajudá-la além do Protocolo Raiz e
que você está por aqui caso ela queira conversar e se aprofundar no que acontece com ela.

Nome: ${nome}
WhatsApp: ${whatsapp || whats}
Temperatura: ${tierVal}
Score: ${scoreVal}/10
O que mais pesa: ${oqueMaisPesa || dores || 'não informado'}
Histórico: ${Array.isArray(historico) ? historico.join(', ') : historico || 'não informado'}
Saúde: ${Array.isArray(saude) ? saude.join(', ') : saude || 'não informado'}
Comprometimento: ${comprometimento}/5
Maior dificuldade: ${maiorDificuldade || dificuldade || 'não informado'}
Source: ${source || 'não informado'}
Data: ${new Date().toISOString()}

REGRAS OBRIGATÓRIAS para o "leadMessage" desta retomada:
- Curta: no máximo 2 a 3 linhas.
- NÃO faça a mensagem girar em torno do dossiê. No máximo cite de leve "o que te mandamos", sem cobrar leitura e sem que isso seja o foco.
- O foco é o convite genuíno para conversar e se aprofundar, deixando claro que há outras formas de ajudá-la além do Protocolo Raiz.
- Tom leve, genuíno, sem nenhuma pressão. NÃO entre na dor, NÃO faça diagnóstico, NÃO faça oferta.
- Apenas abra espaço para a lead responder e dizer o que precisa.
- NUNCA use travessão (—) nem travessão duplo (--) na comunicação; use vírgula, ponto ou dois pontos no lugar.
- Referência de tom (NÃO copie literalmente): "Não sei se você já teve tempo de abrir o que te mandamos, mas se quiser conversar e se aprofundar sobre o que acontece contigo, estou por aqui, temos outras formas de te ajudar além do Protocolo Raiz."
- O aprofundamento só vem DEPOIS que ela responder (nas próximas mensagens, não nesta).

Responda APENAS em JSON válido. Sem texto antes ou depois. Sem blocos de código.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].text;

  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    console.error('IA não retornou JSON válido:', text);
    return {
      tier: 'warm',
      tierJustificativa: 'Erro ao processar.',
      leadMessage: `Oi ${nome}, aqui é a Karina, da equipe da Evelyn Liu. Não sei se você já teve tempo de abrir o que te mandamos, mas se quiser conversar e se aprofundar sobre o que acontece contigo, estou por aqui. Temos outras formas de te ajudar além do Protocolo Raiz.`,
      sdrBriefing: 'Erro ao gerar briefing. Avalie manualmente.',
      orientacao: { objetivo: '', tom: 'Leve', gancho: '', proximoPasso: '', monitorarDePerto: false },
      followUp24h: `Oi ${nome}, passando para saber se recebeu minha mensagem.`,
      followUp48h: `${nome}, ainda penso no que você compartilhou. Quando quiser conversar, estou aqui.`,
      avisoNatalia: false,
      handoff: false,
      redflag: false,
      redflagMotivo: '',
    };
  }
}

export async function generateReply(phone, newMessage, history, leadData, mode = 'sdr', evelyn = null) {
  const scoreVal = leadData.qualificacao?.score ?? leadData.score ?? '?';
  const tierVal = leadData.qualificacao?.tier || leadData.temperatura || '?';

  const messages = [
    ...sanitizeConversationHistory(history),
    { role: 'user', content: newMessage },
  ];

  const isRecovery = mode === 'recovery';
  const rec = leadData.recovery || {};

  // Modo recovery: conduz pelo prompt de recuperação, foco em fechar a venda.
  // handoff SEMPRE false (não agenda pré-consulta — isso desvalorizaria o
  // produto, já que a sessão individual já está inclusa no Protocolo Raiz).
  const contextPrompt = isRecovery ? `
Contexto: recuperação de checkout do Protocolo Raiz. A lead começou a compra e não
finalizou; você está reengajando para que ela conclua.
Nome: ${leadData.nome || 'não informado'}
${rec.checkout_url ? `Link do checkout: ${rec.checkout_url}` : ''}
${rec.pix_code ? `Pix copia-e-cola: ${rec.pix_code}` : ''}

A lead acabou de responder. Gere a próxima mensagem, mirando fechar a venda do
Protocolo Raiz. NÃO agende pré-consulta, NÃO ofereça nada grátis, NÃO dê desconto.

Responda APENAS em JSON válido. Sem texto antes ou depois. Sem blocos de código:
{
  "leadMessage": "próxima mensagem para enviar à lead",
  "sdrBriefing": "situação atual em 2-3 linhas",
  "handoff": false,
  "handoffTurno": "",
  "redflag": false,
  "redflagMotivo": ""
}

NUNCA defina handoff: true neste modo (recuperação não agenda pré-consulta).
Se detectar crise emocional grave ou teor suicida, defina redflag: true.` : `
Contexto da lead:
Nome: ${leadData.nome}
Score: ${scoreVal}/10
Temperatura: ${tierVal}
Maior dificuldade: ${leadData.maiorDificuldade || leadData.dificuldade || 'não informado'}
O que mais pesa: ${leadData.oqueMaisPesa || leadData.dores || 'não informado'}
Source: ${leadData.source || 'não informado'}

CONTEXTO TÉCNICO EVELYN: ${evelyn?.eligible ? 'ELEGÍVEL' : 'NÃO ELEGÍVEL'}.
Motivo técnico: ${evelyn?.reason || 'não avaliado'}.
Sinais permitidos: ${(evelyn?.signals || []).join(', ') || 'nenhum'}.
Estado atual do branch: ${evelyn?.stage || 'default'}.

A lead acabou de responder. Gere a próxima mensagem.

Responda APENAS em JSON válido. Sem texto antes ou depois. Sem blocos de código:
{
  "leadMessage": "próxima mensagem para enviar à lead",
  "sdrBriefing": "situação atual em 2-3 linhas",
  "handoff": false,
  "handoffTurno": "",
  "redflag": false,
  "redflagMotivo": "",
  "evelynEvent": ""
}

Se a lead sinalizou interesse em agendar e você já perguntou o turno e ela respondeu, defina handoff: true e handoffTurno com o turno informado.
Se detectar crise emocional grave ou teor suicida, defina redflag: true.`;

  const system = mode === 'reativacao' ? REATIVACAO_PROMPT
    : isRecovery ? RECUPERACAO_PROMPT : SYSTEM_PROMPT;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryInstruction = attempt === 1 ? '' : `

ATENÇÃO: a tentativa anterior não produziu uma resposta utilizável. Gere novamente
o objeto JSON COMPLETO e preencha leadMessage com texto não vazio, exceto se
redflag for true. Não inclua markdown nem comentários fora do JSON.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      system,
      messages: [
        ...messages,
        { role: 'user', content: contextPrompt + retryInstruction }
      ],
    });

    try {
      return parseGeneratedReply(anthropicText(response));
    } catch (err) {
      console.warn(`⚠️ Resposta inválida da IA para ${phone} (tentativa ${attempt}/2): ${err.message}`);
    }
  }

  // Nunca repassa texto técnico nem mensagem vazia à lead. Se a IA falhar duas
  // vezes, envia uma continuidade neutra e pausa para a Karina revisar.
  return manualReviewFallback(mode);
}

export async function generateHandoffBriefing(leadData, history, turno) {
  const scoreVal = leadData.qualificacao?.score ?? leadData.score ?? '?';
  const tierVal = leadData.qualificacao?.tier || leadData.temperatura || '?';

  const conversaTexto = history
    .map(m => `${m.role === 'user' ? 'Lead' : 'Agente'}: ${m.content}`)
    .join('\n');

  const prompt = `
Você é consultor de vendas. Resuma a conversa abaixo para a SDR que vai assumir o agendamento.

DADOS DA LEAD:
Nome: ${leadData.nome}
Score: ${scoreVal}/10
Temperatura: ${tierVal}
Turno preferido: ${turno}

CONVERSA:
${conversaTexto}

Responda em texto corrido, máximo 6 linhas. Inclua:
1. Dores principais que a lead revelou
2. Nível de interesse percebido
3. Como abordar o agendamento com ela`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text;
}

export async function generateConsultivo(pergunta, historico = []) {
  // Mantém histórico da conversa consultiva com a Karina
  const messages = [
    ...historico,
    { role: 'user', content: pergunta },
  ];

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1000,
    system: CONSULTIVO_PROMPT,
    messages,
  });

  return response.content[0].text;
}

export async function generatePlano(input) {
  const ARQUITETO_PROMPT = readFileSync(
    join(__dirname, '../../config/prompts/arquiteto.txt'),
    'utf-8'
  );

  const hoje = new Date().toLocaleDateString('pt-BR', {
    day: 'numeric', month: 'long', year: 'numeric'
  });

  const prompt = `Hoje é ${hoje}.

A Karina enviou os seguintes dados para gerar a proposta:

${input}

Gere o conteúdo personalizado conforme as instruções. Responda APENAS em JSON válido, sem texto antes ou depois, sem blocos de código.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4000,
    system: ARQUITETO_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;

  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    console.error('Arquiteto não retornou JSON válido:', text);
    throw new Error('Falha ao gerar conteúdo da proposta');
  }
}

export async function generateDossie(leadData) {
  const DOSSIE_PROMPT = readFileSync(
    join(__dirname, '../../config/prompts/dossie.txt'),
    'utf-8'
  );

  const { nome, perfil, historico, respostas, source, tier } = leadData;

  const respostasTexto = Array.isArray(respostas)
    ? respostas.map(r => `${r.pergunta}: ${r.resposta}`).join('\n')
    : respostas;

  const prompt = `
Lead: ${nome}
Perfil: ${perfil}
Tier (qualificação): ${tier || 'não informado'} (hot = já investiu muito antes; warm = tentou algumas coisas; cold = primeiro passo)
Histórico de tentativas: ${historico || 'não informado'}
Source: ${source || 'não informado'}

Respostas do quiz:
${respostasTexto || 'não informado'}

Gere a personalização para essa lead. Responda APENAS em JSON válido, sem texto antes ou depois, sem blocos de código.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 800,
    system: DOSSIE_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text;

  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    console.error('Erro ao gerar dossiê:', text);
    return {
      whatsappMessage: `Seu resultado saiu, ${nome}.\nTem uma coisa específica que apareceu no seu perfil.\nGeramos esse dossiê com base nas suas respostas pra te ajudar a enxergar isso:`,
      identificacaoParagrafo: '',
      sinaisPersonalizados: [],
    };
  }
}

/**
 * Classifica a resposta de um lead a uma campanha de reativação como interesse
 * POSITIVO (quer prioridade/saber mais) ou não. A intenção prevalece sobre a
 * palavra exata — "faz sentido", "me chama", "tenho interesse na Evelyn" contam
 * como positivo mesmo sem dizer "quero". Heurística de palavra cobre o caminho
 * feliz sem custo; a IA resolve os ambíguos.
 */
const POSITIVE_HINTS = [
  'quero', 'sim', 'tenho interesse', 'interesse', 'faz sentido', 'gostaria',
  'me chama', 'pode chamar', 'saber mais', 'bora', 'vamos', 'aceito', 'topo',
  'com certeza', 'claro', 'evelyn', 'prioridade', 'manda', 'quero saber',
];
const NEGATIVE_HINTS = [
  'não quero', 'nao quero', 'não tenho interesse', 'nao tenho interesse',
  'não', 'nao', 'agora não', 'agora nao', 'sair', 'parar', 'descadastr', 'pare',
];

export async function classifyCampaignIntent(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return { positive: false, source: 'empty' };

  const hasNeg = NEGATIVE_HINTS.some(h => t.includes(h));
  const hasPos = POSITIVE_HINTS.some(h => t.includes(h));
  // Sinais claros e sem ambiguidade → decide direto (sem custo de IA).
  if (hasPos && !hasNeg) return { positive: true, source: 'keyword' };
  if (hasNeg && !hasPos) return { positive: false, source: 'keyword' };

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 50,
      system:
        'Você classifica a resposta de um lead a um convite para uma lista VIP (abertura de vagas para acompanhamento nutricional pago). ' +
        'Responda APENAS JSON {"positive": true|false}. positive=true se a pessoa demonstra interesse, quer prioridade, ' +
        'quer saber mais ou aceita; positive=false se recusa, demonstra desinteresse, pede para parar ou apenas faz uma ' +
        'pergunta neutra sem sinal de interesse. A intenção prevalece sobre a palavra exata.',
      messages: [{ role: 'user', content: `Resposta do lead: "${text}"` }],
    });
    const raw = response.content[0].text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);
    return { positive: parsed.positive === true, source: 'ai' };
  } catch (err) {
    console.error('[campanha] classificador IA falhou, fallback keyword:', err.message);
    // Fallback conservador: na dúvida, trata como positivo para não perder lead
    // quente (a Karina valida no handoff de qualquer forma).
    return { positive: hasPos, source: 'fallback' };
  }
}

// ─── Inbound WhatsApp (anúncio / story) ──────────────────────────────────────
//
// Fluxo novo, instância Z-API própria. A diferença em relação ao SDR normal é
// que aqui NÃO existe formulário: a qualificação toda é feita na conversa, e
// precisa ser mais robusta, porque é ela que decide se a lead merece a agenda
// de uma nutricionista.
//
// O que é validado em CÓDIGO e não no prompt: os enums, e o gate de handoff.
// Prompt não é mecanismo de segurança — a lição de 14/10/2026 foi essa.

const INBOUND_PROMPT = readFileSync(
  join(__dirname, '../../config/prompts/inbound.txt'),
  'utf-8'
);

const INBOUND_PADROES = ['escape', 'ciclo', 'culpa', 'autoestima', 'rotina', 'saude', 'nao_informado'];
const INBOUND_TENTATIVAS = ['dieta', 'jejum', 'nutri', 'nutri_comp', 'psi', 'remedio', 'coach', 'cirurgia', 'nenhum'];
const INBOUND_SAUDE = ['hipo', 'sop', 'ri', 'diabetes', 'meno', 'ansiedade', 'colesterol', 'nenhuma', 'nao_informado'];
const INBOUND_PRONTIDAO = ['alta', 'media', 'baixa', 'nao_informado'];
const INBOUND_TURNOS = ['manha', 'tarde', 'noite'];
const INBOUND_DIAS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];
const INBOUND_ETAPAS = ['acolhimento', 'qualificando', 'disponibilidade', 'pronta', 'protocolo_raiz', 'encerrada'];
// Motivos que dispensam disponibilidade: não são handoff de agendamento.
const INBOUND_MOTIVOS_DIRETOS = ['pediu_evelyn', 'pediu_humano', 'fora_do_roteiro', 'ja_paciente'];

function listaLimpa(valor, permitidos) {
  if (!Array.isArray(valor)) return [];
  const norm = v => String(v || '').toLowerCase().trim()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  return [...new Set(valor.map(norm).filter(v => permitidos.includes(v)))];
}

/**
 * Funde o que já se sabia com o que a IA devolveu agora.
 *
 * O prompt pede estado cumulativo, mas a fusão acontece aqui de propósito: se
 * o modelo esquecer de repetir um campo numa rodada, a informação que a pessoa
 * já contou não pode evaporar — e com ela o gate de qualificação.
 */
export function fundirQualificacaoInbound(anterior = {}, novo = {}) {
  const ant = anterior || {};
  const padraoNovo = INBOUND_PADROES.includes(novo.padrao) && novo.padrao !== 'nao_informado'
    ? novo.padrao : null;
  const prontidaoNova = INBOUND_PRONTIDAO.includes(novo.prontidao) && novo.prontidao !== 'nao_informado'
    ? novo.prontidao : null;
  const dorNova = typeof novo.dor_texto === 'string' ? novo.dor_texto.trim() : '';
  const dorAnterior = typeof ant.dor_texto === 'string' ? ant.dor_texto.trim() : '';

  const tentativas = [...new Set([
    ...listaLimpa(ant.tentativas, INBOUND_TENTATIVAS),
    ...listaLimpa(novo.tentativas, INBOUND_TENTATIVAS),
  ])];
  const saude = [...new Set([
    ...listaLimpa(ant.saude, INBOUND_SAUDE),
    ...listaLimpa(novo.saude, INBOUND_SAUDE),
  ])];

  const fundida = {
    padrao: padraoNovo || ant.padrao || 'nao_informado',
    tentativas,
    saude,
    // Texto maior ganha: a pessoa costuma ir detalhando a dor ao longo da
    // conversa, e trocar um relato longo por um resumo curto perde o que a
    // nutricionista mais usa.
    dor_texto: dorNova.length >= dorAnterior.length ? dorNova : dorAnterior,
    prontidao: prontidaoNova || ant.prontidao || 'nao_informado',
  };

  // `completa` é calculada aqui, nunca lida do modelo.
  fundida.completa = fundida.padrao !== 'nao_informado'
    && fundida.tentativas.length > 0
    && fundida.dor_texto.length >= 25;

  return fundida;
}

export function fundirDisponibilidadeInbound(anterior = {}, novo = {}) {
  const ant = anterior || {};
  const turnos = [...new Set([
    ...listaLimpa(ant.turnos, INBOUND_TURNOS),
    ...listaLimpa(novo.turnos, INBOUND_TURNOS),
  ])];
  const dias = [...new Set([
    ...listaLimpa(ant.dias, INBOUND_DIAS),
    ...listaLimpa(novo.dias, INBOUND_DIAS),
  ])];
  const textoNovo = typeof novo.texto === 'string' ? novo.texto.trim() : '';
  return { turnos, dias, texto: textoNovo || (ant.texto || '') };
}

function pontuarInbound(q) {
  let s = 0;
  if (q.dor_texto && q.dor_texto.length >= 25) s += 3;
  if (q.tentativas.some(t => t !== 'nenhum')) s += 2;
  if (['escape', 'ciclo', 'culpa', 'autoestima'].includes(q.padrao)) s += 2;
  if (q.saude.some(c => c !== 'nenhuma' && c !== 'nao_informado')) s += 1;
  if (q.prontidao === 'alta') s += 2;
  else if (q.prontidao === 'media') s += 1;
  return Math.min(10, s);
}

function contextoInbound({ origem, qualificacao, disponibilidade, nome, mensagensDoAgente }) {
  const q = qualificacao || {};
  const d = disponibilidade || {};
  const falta = [];
  if (!q.padrao || q.padrao === 'nao_informado') falta.push('padrao');
  if (!q.tentativas?.length) falta.push('tentativas');
  if (!q.dor_texto || q.dor_texto.length < 25) falta.push('dor_texto');
  if (!q.saude?.length) falta.push('saude');
  if (!q.prontidao || q.prontidao === 'nao_informado') falta.push('prontidao');

  return [
    'ESTADO DESTA CONVERSA (apurado pelo sistema, não pelo modelo):',
    `Origem do clique: ${origem || 'direto'}`,
    nome ? `Nome: ${nome}` : 'Nome: ainda não informado',
    `Mensagens que você já enviou: ${mensagensDoAgente} (orçamento de qualificação: 5)`,
    '',
    'Já apurado:',
    `  padrao: ${q.padrao || 'nao_informado'}`,
    `  tentativas: ${q.tentativas?.length ? q.tentativas.join(', ') : 'nada ainda'}`,
    `  dor_texto: ${q.dor_texto ? `"${q.dor_texto.slice(0, 300)}"` : 'nada ainda'}`,
    `  saude: ${q.saude?.length ? q.saude.join(', ') : 'nada ainda'}`,
    `  prontidao: ${q.prontidao || 'nao_informado'}`,
    `  qualificação completa: ${q.completa ? 'SIM' : 'NÃO'}`,
    `  disponibilidade: turnos [${(d.turnos || []).join(', ')}] dias [${(d.dias || []).join(', ')}]`,
    '',
    falta.length ? `Ainda falta descobrir: ${falta.join(', ')}` : 'Qualificação completa.',
    q.completa && (!d.turnos?.length || !d.dias?.length)
      ? 'A qualificação está completa. Se ela demonstrou interesse, peça turnos E dias da semana.'
      : '',
    'Devolva o estado CUMULATIVO: tudo o que você já sabe, não só o que apareceu agora.',
  ].filter(Boolean).join('\n');
}

/**
 * Primeira mensagem do inbound. A pessoa acabou de clicar no anúncio e não
 * compartilhou nada: não existe dor para validar ainda, só uma pergunta aberta.
 */
export async function generateInboundFirstContact({ origem = 'direto' } = {}) {
  const resposta = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 900,
    system: INBOUND_PROMPT,
    messages: [{ role: 'user', content: `
Uma pessoa acabou de chegar pelo link (origem: ${origem}) e enviou a frase de entrada do anúncio. Ela ainda não contou nada sobre si.

Escreva a PRIMEIRA mensagem, seguindo a seção PRIMEIRA MENSAGEM do seu prompt.

Responda no formato JSON definido, com etapa "acolhimento".` }],
  });

  return normalizarRespostaInbound(anthropicText(resposta), {}, {}, 0);
}

/**
 * Conduz a conversa do inbound. `estado` é o que já foi apurado nas rodadas
 * anteriores; a fusão e os gates acontecem em normalizarRespostaInbound.
 */
export async function generateInboundReply({
  historico = [], mensagem, origem = 'direto', nome = '',
  qualificacao = {}, disponibilidade = {}, mensagensDoAgente = 0,
}) {
  const resposta = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1400,
    system: INBOUND_PROMPT,
    messages: [
      ...sanitizeConversationHistory(historico),
      { role: 'user', content: `
${contextoInbound({ origem, qualificacao, disponibilidade, nome, mensagensDoAgente })}

Mensagem dela agora: "${mensagem}"

Responda no formato JSON definido.` },
    ],
  });

  return normalizarRespostaInbound(
    anthropicText(resposta), qualificacao, disponibilidade, mensagensDoAgente
  );
}

/**
 * Valida, funde e aplica os gates. Exportada para teste direto, sem LLM.
 *
 * O gate que importa: handoff de agendamento SÓ passa com turnos E dias. O
 * prompt pede isso, mas pedir não é garantir — a Karina ligar sem saber a
 * disponibilidade é exatamente o que esta função impede.
 */
export function normalizarRespostaInbound(bruto, qualificacaoAnterior, disponibilidadeAnterior, mensagensDoAgente = 0) {
  let p;
  try {
    p = JSON.parse(String(bruto || '').replace(/```json|```/gi, '').trim());
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('formato');
  } catch {
    console.error('[inbound] IA não devolveu JSON válido:', String(bruto || '').slice(0, 200));
    return {
      ok: false,
      leadMessage: '',
      qualificacao: fundirQualificacaoInbound(qualificacaoAnterior, {}),
      disponibilidade: fundirDisponibilidadeInbound(disponibilidadeAnterior, {}),
      score: 0, tier: 'cold', etapa: 'qualificando',
      handoff: true, handoffMotivo: 'erro_tecnico',
      redflag: false, redflagMotivo: '', sdrBriefing: '', nome: '',
    };
  }

  const qualificacao = fundirQualificacaoInbound(qualificacaoAnterior, p.qualificacao || {});
  const disponibilidade = fundirDisponibilidadeInbound(disponibilidadeAnterior, p.disponibilidade || {});
  const score = pontuarInbound(qualificacao);
  const tier = score >= 6 ? 'hot' : score >= 3 ? 'warm' : 'cold';
  const redflag = p.redflag === true;
  const leadMessage = typeof p.leadMessage === 'string' ? p.leadMessage.trim() : '';

  const motivoBruto = typeof p.handoffMotivo === 'string' ? p.handoffMotivo.trim() : '';
  const temDisponibilidade = disponibilidade.turnos.length > 0 && disponibilidade.dias.length > 0;
  const motivoDireto = INBOUND_MOTIVOS_DIRETOS.includes(motivoBruto);

  // Gate de handoff. Agendamento exige disponibilidade completa; os outros
  // motivos (pediu a Evelyn, pediu humano, fora do roteiro, já é paciente)
  // passam direto porque não têm nada a ver com agenda.
  let handoff = p.handoff === true;
  let handoffMotivo = motivoBruto;
  if (handoff && !motivoDireto) {
    if (temDisponibilidade) {
      handoffMotivo = 'pronta_para_agendar';
    } else {
      console.warn('[inbound] handoff recusado: sem turnos e dias ainda');
      handoff = false;
      handoffMotivo = '';
    }
  }

  return {
    ok: true,
    leadMessage,
    nome: typeof p.nome === 'string' ? p.nome.trim().split(/\s+/)[0] : '',
    qualificacao,
    disponibilidade,
    score,
    tier,
    etapa: INBOUND_ETAPAS.includes(p.etapa) ? p.etapa : 'qualificando',
    handoff,
    handoffMotivo,
    redflag,
    redflagMotivo: typeof p.redflagMotivo === 'string' ? p.redflagMotivo.trim() : '',
    sdrBriefing: typeof p.sdrBriefing === 'string' ? p.sdrBriefing.trim() : '',
    mensagensDoAgente,
  };
}
