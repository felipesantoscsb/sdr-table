// src/ai/anthropic.js
//
// DECISÃO TÉCNICA: Por que o prompt fica em config/prompts/sdr.txt?
// → Para que a equipe consiga editar o comportamento do agente sem mexer em código.
//   No Railway, basta editar o arquivo no GitHub e o servidor atualiza sozinho.

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from '../../config/index.js';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// Carrega o prompt do arquivo externo uma vez ao iniciar o servidor
// Motivo: evitar leitura de disco a cada requisição
const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(
  join(__dirname, '../../config/prompts/sdr.txt'),
  'utf-8'
);

/**
 * Gera a primeira mensagem para um novo lead + briefing para a SDR.
 */
export async function generateFirstContact(leadData) {
  const {
    nome, whatsapp, temperatura, score,
    oqueMaisPesa, historico, saude,
    comprometimento, maiorDificuldade, source
  } = leadData;

  const userPrompt = `
🚨 Novo lead recebido

Nome: ${nome}
WhatsApp: ${whatsapp}
Temperatura: ${temperatura}
Score: ${score}
O que mais pesa: ${oqueMaisPesa || 'não informado'}
Histórico: ${Array.isArray(historico) ? historico.join(', ') : historico || 'não informado'}
Saúde: ${Array.isArray(saude) ? saude.join(', ') : saude || 'não informado'}
Comprometimento: ${comprometimento}/5
Maior dificuldade: ${maiorDificuldade || 'não informado'}
Source: ${source || 'não informado'}
Data: ${new Date().toISOString()}

Entregue:
1. Tier confirmado com justificativa
2. Primeira mensagem pronta para WhatsApp
3. Orientação estratégica completa
4. Dois follow-ups (24h e 48h)

Responda em JSON com as chaves:
{
  "tier": "hot|warm|cold",
  "tierJustificativa": "...",
  "leadMessage": "mensagem para enviar à lead",
  "orientacao": {
    "objetivo": "...",
    "tom": "...",
    "gancho": "...",
    "proximoPasso": "..."
  },
  "followUp24h": "...",
  "followUp48h": "...",
  "avisoNatalia": true|false
}

Responda APENAS o JSON, sem texto antes ou depois.`;

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0].text;

  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    console.error('⚠️  IA não retornou JSON válido:', text);
    return {
      tier: 'warm',
      tierJustificativa: 'Erro ao processar. Avalie manualmente.',
      leadMessage: `Oi ${nome}! Aqui é a Karina, da equipe da Evelyn Liu. Vi as respostas que você preencheu e queria te falar pessoalmente. O que você compartilhou fez muito sentido pra mim. Posso te perguntar uma coisa?`,
      orientacao: {
        objetivo: 'Erro ao gerar. Avalie manualmente.',
        tom: 'Acolhedor',
        gancho: 'Não gerado',
        proximoPasso: 'Avalie manualmente',
      },
      followUp24h: `Oi ${nome}, passando para saber se recebeu minha mensagem.`,
      followUp48h: `${nome}, ainda penso no que você compartilhou. Quando quiser conversar, estou aqui.`,
      avisoNatalia: false,
    };
  }
}

/**
 * Processa resposta de um lead que já está em conversa ativa.
 */
export async function generateReply(phone, newMessage, history, leadData) {
  const messages = [
    ...history,
    { role: 'user', content: newMessage },
  ];

  const contextPrompt = `
Contexto da lead:
Nome: ${leadData.nome}
Score: ${leadData.score}
Maior dificuldade: ${leadData.maiorDificuldade || 'não informado'}
O que mais pesa: ${leadData.oqueMaisPesa || 'não informado'}
Source: ${leadData.source || 'não informado'}

A lead acabou de responder. Sugira a próxima mensagem para a SDR enviar.
Responda em JSON:
{
  "leadMessage": "próxima mensagem para enviar à lead",
  "sdrBriefing": "situação atual e orientação para a SDR em 2-3 linhas"
}
Responda APENAS o JSON.`;

  const response = await client.messages.create({
    model: config.anthropic.model,
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
      sdrBriefing: 'Erro interno. Revise a conversa e responda manualmente.',
    };
  }
}
