// src/disparos/handler.js

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateDossie } from '../ai/anthropic.js';
import { gerarDossie } from './gerador.js';
import { sendMessage } from '../zapi/sender.js';
import { normalizePhone } from '../conversation/store.js';
import { config } from '../../config/index.js';
import { safeSet } from '../redis.js';

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
  const nome = body.nome || body.Nome || 'você';
  const phone = normalizePhone(body.whatsapp || body.whats || '');
  const perfil = resolverPerfil(body.perfil || body.profile || '');
  const historico = Array.isArray(body.historico) ? body.historico.join(', ') : body.historico || '';
  const respostas = parseRespostas(body.respostas);
  const source = body.source || '';

  if (!phone) {
    return res.status(400).json({ error: 'WhatsApp obrigatório' });
  }

  // Log completo do input para debugging
  console.log(`📨 Disparo recebido:
  Nome: ${nome}
  Phone: ${phone}
  Perfil original: "${body.perfil || body.profile}" → resolvido: ${perfil}
  Histórico: ${historico || 'vazio'}
  Respostas: ${respostas.length} itens
  Source: ${source}`);

  res.status(200).json({ received: true, phone, perfil });

  const agendarDisparo = async () => {
    try {
      console.log(`🤖 Gerando dossiê para ${nome} (perfil ${perfil}, ${respostas.length} respostas)...`);

      const personalizado = await generateDossie({ nome, perfil, historico, respostas, source });
      console.log(`✅ Conteúdo gerado — mensagem: "${personalizado.whatsappMessage?.slice(0, 60)}..."`);

      const html = gerarDossie(perfil, nome, personalizado.identificacaoParagrafo, personalizado.sinaisPersonalizados);
      console.log(`📄 HTML gerado (${html.length} chars)`);

      const slug = `${slugify(nome)}-${Date.now()}`;
      const filename = `${slug}.html`;
      writeFileSync(join(DOSSIES_DIR, filename), html, 'utf-8');

      const url = `https://www.evelynliu.com.br/d/${slug}`;
      const mensagem = `${personalizado.whatsappMessage}\n${url}`;

      // Salva metadados no Redis para servir o dossiê via /d/:slug
      await safeSet(
        `dossie:${slug}`,
        JSON.stringify({ phone, perfil, slug, url }),
        'EX', 7 * 24 * 60 * 60
      );

      await sendMessage(phone, mensagem);
      console.log(`✅ Dossiê enviado para ${nome}: ${url}`);

    } catch (err) {
      console.error(`❌ Erro no disparo para ${nome} (${phone}):`, err.message);
      console.error(err.stack);
    }
  };

  if (dentroDoHorario()) {
    console.log(`⏳ Disparo agendado para ${nome} em 15 minutos`);
    setTimeout(agendarDisparo, DELAY_MS);
  } else {
    const msAte8 = msAteAbertura();
    const totalDelay = msAte8 + DELAY_MS;
    console.log(`⏰ Fora do horário — disparo para ${nome} em ${Math.round(totalDelay / 60000)} minutos`);
    setTimeout(agendarDisparo, totalDelay);
  }
}

/**
 * Agenda envio de dossiê para um lead sem passar por req/res.
 * Usado internamente pelo fluxo de quiz.
 */
export function scheduleDisparo({ nome, phone, perfil: perfilRaw, historico: historicoRaw, respostas: respostasRaw, source: src }) {
  const perfil     = resolverPerfil(perfilRaw || '');
  const historico  = Array.isArray(historicoRaw) ? historicoRaw.join(', ') : (historicoRaw || '');
  const respostas  = parseRespostas(respostasRaw);
  const source     = src || '';

  const enviar = async () => {
    try {
      console.log(`🤖 [quiz] Gerando dossiê para ${nome} (perfil ${perfil}, ${respostas.length} respostas)...`);
      const personalizado = await generateDossie({ nome, perfil, historico, respostas, source });
      const html = gerarDossie(perfil, nome, personalizado.identificacaoParagrafo, personalizado.sinaisPersonalizados);
      const slug = `${slugify(nome)}-${Date.now()}`;
      const filename = `${slug}.html`;
      writeFileSync(join(DOSSIES_DIR, filename), html, 'utf-8');
      const url = `https://www.evelynliu.com.br/d/${slug}`;
      const mensagem = `${personalizado.whatsappMessage}\n${url}`;
      await safeSet(
        `dossie:${slug}`,
        JSON.stringify({ phone, perfil, slug, url }),
        'EX', 7 * 24 * 60 * 60
      );
      await sendMessage(phone, mensagem);
      console.log(`✅ [quiz] Dossiê enviado para ${nome}: ${url}`);
    } catch (err) {
      console.error(`❌ [quiz] Erro no disparo para ${nome} (${phone}):`, err.message);
    }
  };

  if (dentroDoHorario()) {
    console.log(`⏳ [quiz] Disparo agendado para ${nome} em 15 minutos`);
    setTimeout(enviar, DELAY_MS);
  } else {
    const totalDelay = msAteAbertura() + DELAY_MS;
    console.log(`⏰ [quiz] Fora do horário — disparo para ${nome} em ${Math.round(totalDelay / 60000)} minutos`);
    setTimeout(enviar, totalDelay);
  }
}
