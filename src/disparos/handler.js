// src/disparos/handler.js

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateDossie } from '../ai/anthropic.js';
import { gerarDossie } from './gerador.js';
import { sendMessage } from '../zapi/sender.js';
import { normalizePhone } from '../conversation/store.js';
import { config } from '../../config/index.js';
import { safeSet, safeDel } from '../redis.js';

const PENDING_DOSSIE_TTL = 24 * 60 * 60; // 24h — cobre fora-de-horário

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOSSIES_DIR = join(__dirname, '../../public/planos');
const DELAY_MS = 15 * 60 * 1000;

if (!existsSync(DOSSIES_DIR)) {
  mkdirSync(DOSSIES_DIR, { recursive: true });
}

function resolverPerfil(perfil) {
  if (!perfil) return 'E';
  const p = perfil.toString().trim();
  if (['E', 'R', 'S', 'A'].includes(p.toUpperCase())) return p.toUpperCase();
  const lower = p.toLowerCase();
  if (lower.includes('emocional')) return 'E';
  if (lower.includes('restritiva')) return 'R';
  if (lower.includes('sobreviv')) return 'S';
  if (lower.includes('desconectada')) return 'A';
  const first = p[0].toUpperCase();
  if (['E', 'R', 'S', 'A'].includes(first)) return first;
  return 'E';
}

// Garante que respostas seja sempre um array de objetos {pergunta, resposta}
function parseRespostas(raw) {
  if (!raw) return [];

  // Já é array
  if (Array.isArray(raw)) return raw;

  // É string JSON
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // É texto puro, retorna como item único
      return [{ pergunta: 'Contexto', resposta: raw }];
    }
  }

  // É objeto único
  if (typeof raw === 'object') return [raw];

  return [];
}

function slugify(nome) {
  return nome
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function dentroDoHorario() {
  const brasilia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dia = brasilia.getDay();
  const hora = brasilia.getHours();
  const fds = dia === 0 || dia === 6;
  if (fds) return hora >= 8 && hora < 17;
  return hora >= 8 && hora < 21;
}

function msAteAbertura() {
  const brasilia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hora = brasilia.getHours();
  const minuto = brasilia.getMinutes();
  const minutosAte8h = (24 - hora + 8) * 60 - minuto;
  return minutosAte8h * 60 * 1000;
}

export async function handleDisparo(req, res) {
  const secret = req.headers['x-webhook-secret'] || req.body.secret;
  if (secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const body = req.body;

  // Log bruto do payload para debug de mapeamento de campos
  console.log(`📨 Payload bruto recebido:`, JSON.stringify(body, null, 2));

  const nome     = body.nome || body.Nome || 'você';
  const phone    = normalizePhone(body.whatsapp || body.whats || '');
  const perfil   = resolverPerfil(body.perfil || body.profile || body.profileName || '');
  const historico = Array.isArray(body.historico) ? body.historico.join(', ') : body.historico || '';
  // Make envia as respostas no campo "Perguntas e respostas" (com espaço e acento)
  const respostasRaw = body['Perguntas e respostas'] || body.respostas || body['perguntas_e_respostas'] || '';
  const respostas  = parseRespostas(respostasRaw);
  const source     = body.source || '';

  if (!phone) {
    return res.status(400).json({ error: 'WhatsApp obrigatório' });
  }

  console.log(`📨 Disparo mapeado:
  Nome: ${nome}
  Phone: ${phone}
  Perfil original: "${body.perfil || body.profile}" → resolvido: ${perfil}
  Histórico: ${historico || 'vazio'}
  Respostas raw (campo): ${respostasRaw ? `"${String(respostasRaw).slice(0, 80)}..."` : 'vazio'}
  Respostas parseadas: ${respostas.length} itens
  Source: ${source}`);

  res.status(200).json({ received: true, phone, perfil });

  const delay = dentroDoHorario() ? DELAY_MS : msAteAbertura() + DELAY_MS;
  const fire_at = Date.now() + delay;

  await safeSet(
    `pending_dossie:${phone}`,
    JSON.stringify({ phone, leadData: { nome, perfil, historico, respostas, source }, scheduled_at: Date.now(), fire_at }),
    'EX', PENDING_DOSSIE_TTL
  );

  if (dentroDoHorario()) {
    console.log(`⏳ Disparo agendado para ${nome} em 15 minutos`);
  } else {
    console.log(`⏰ Fora do horário — disparo para ${nome} em ${Math.round(delay / 60000)} minutos`);
  }
  setTimeout(() => fireDossie({ nome, phone, perfil, historico, respostas, source }), delay);
}

/**
 * Envia o dossiê imediatamente (sem agendamento).
 * Chamado pelo setTimeout e pela recovery de redeploy.
 */
export async function fireDossie({ nome, phone, perfil, historico, respostas, source }) {
  try {
    console.log(`🤖 Gerando dossiê para ${nome} (perfil ${perfil}, ${respostas.length} respostas)...`);
    const personalizado = await generateDossie({ nome, perfil, historico, respostas, source });
    console.log(`✅ Conteúdo gerado — mensagem: "${personalizado.whatsappMessage?.slice(0, 60)}..."`);

    const html = gerarDossie(perfil, nome, personalizado.identificacaoParagrafo, personalizado.sinaisPersonalizados);
    console.log(`📄 HTML gerado (${html.length} chars)`);

    const slug = `${slugify(nome)}-${Date.now()}`;
    const filename = `${slug}.html`;
    writeFileSync(join(DOSSIES_DIR, filename), html, 'utf-8');

    const url = `https://raiz.evelynliu.com.br/d/${slug}`;
    const mensagem = `${personalizado.whatsappMessage}\n${url}`;

    await safeSet(
      `dossie:${slug}`,
      JSON.stringify({ phone, perfil, slug, url }),
      'EX', 7 * 24 * 60 * 60
    );

    await sendMessage(phone, mensagem);
    await safeDel(`pending_dossie:${phone}`);
    console.log(`✅ Dossiê enviado para ${nome}: ${url}`);
  } catch (err) {
    console.error(`❌ Erro no disparo para ${nome} (${phone}):`, err.message);
    console.error(err.stack);
  }
}

/**
 * Agenda envio de dossiê para um lead sem passar por req/res.
 * Usado internamente pelo fluxo de quiz.
 */
export async function scheduleDisparo({ nome, phone, perfil: perfilRaw, historico: historicoRaw, respostas: respostasRaw, source: src }) {
  const perfil    = resolverPerfil(perfilRaw || '');
  const historico = Array.isArray(historicoRaw) ? historicoRaw.join(', ') : (historicoRaw || '');
  const respostas = parseRespostas(respostasRaw);
  const source    = src || '';

  const delay   = dentroDoHorario() ? DELAY_MS : msAteAbertura() + DELAY_MS;
  const fire_at = Date.now() + delay;

  await safeSet(
    `pending_dossie:${phone}`,
    JSON.stringify({ phone, leadData: { nome, perfil, historico, respostas, source }, scheduled_at: Date.now(), fire_at }),
    'EX', PENDING_DOSSIE_TTL
  );

  if (dentroDoHorario()) {
    console.log(`⏳ [quiz] Disparo agendado para ${nome} em 15 minutos`);
  } else {
    console.log(`⏰ [quiz] Fora do horário — disparo para ${nome} em ${Math.round(delay / 60000)} minutos`);
  }
  setTimeout(() => fireDossie({ nome, phone, perfil, historico, respostas, source }), delay);
}
