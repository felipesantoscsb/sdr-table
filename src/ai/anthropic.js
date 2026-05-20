// src/ai/anthropic.js

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from '../../config/index.js';

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

export async function generateReply(phone, newMessage, history, leadData) {
  const scoreVal = leadData.qualificacao?.score ?? leadData.score ?? '?';
  const tierVal = leadData.qualificacao?.tier || leadData.temperatura || '?';

  const messages = [
    ...history,
    { role: 'user', content: newMessage },
  ];

  const contextPrompt = `
Contexto da lead:
Nome: ${leadData.nome}
Score: ${scoreVal}/10
Temperatura: ${tierVal}
Maior dificuldade: ${leadData.maiorDificuldade || leadData.dificuldade || 'não informado'}
O que mais pesa: ${leadData.oqueMaisPesa || leadData.dores || 'não informado'}
Source: ${leadData.source || 'não informado'}

A lead acabou de responder. Gere a próxima mensagem.

Responda APENAS em JSON válido. Sem texto antes ou depois. Sem blocos de código:
{
  "leadMessage": "próxima mensagem para enviar à lead",
  "sdrBriefing": "situação atual em 2-3 linhas",
  "handoff": false,
  "handoffTurno": "",
  "redflag": false,
  "redflagMotivo": ""
}

Se a lead sinalizou interesse em agendar e você já perguntou o turno e ela respondeu, defina handoff: true e handoffTurno com o turno informado.
Se detectar crise emocional grave ou teor suicida, defina redflag: true.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: [
      ...messages,
      { role: 'user', content: contextPrompt }
    ],
  });

  const text = response.content[0].text;

  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return {
      leadMessage: 'Erro ao gerar resposta. Responda manualmente.',
      sdrBriefing: 'Erro interno.',
      handoff: false,
      handoffTurno: '',
      redflag: false,
      redflagMotivo: '',
    };
  }
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
