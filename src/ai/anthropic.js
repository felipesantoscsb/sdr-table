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

Responda APENAS em JSON válido com as chaves:
{
  "tier": "hot|warm|cold",
  "tierJustificativa": "...",
  "leadMessage": "mensagem para enviar à lead",
  "sdrBriefing": "briefing completo para a SDR",
  "orientacao": {
    "objetivo": "...",
    "tom": "...",
    "gancho": "...",
    "proximoPasso": "...",
    "monitorarDePerto": true|false
  },
  "followUp24h": "...",
  "followUp48h": "...",
  "avisoNatalia": true|false,
  "handoff": false,
  "redflag": false,
  "redflagMotivo": ""
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1500,
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
      leadMessage: `Oi ${nome}! Aqui é a Karina, da equipe da Evelyn Liu. Vi as respostas que você preencheu e queria te falar pessoalmente sobre o que você compartilhou. Posso te fazer uma pergunta?`,
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

Responda APENAS em JSON:
{
  "leadMessage": "próxima mensagem para enviar à lead",
  "sdrBriefing": "situação atual em 2-3 linhas",
  "handoff": false,
  "handoffTurno": "",
  "redflag": false,
  "redflagMotivo": ""
}

Se a lead sinalizou interesse em agendar e você já perguntou o turno e ela respondeu, defina handoff: true e handoffTurno com o turno que ela informou.
Se detectar crise emocional grave ou teor suicida, defina redflag: true.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 800,
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
