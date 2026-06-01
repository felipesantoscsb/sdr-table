// src/disparos/handler.js

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generateDossie } from '../ai/anthropic.js';
import { gerarDossie } from './gerador.js';
import { sendMessage } from '../zapi/sender.js';
import { normalizePhone } from '../conversation/store.js';
import { config } from '../../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOSSIES_DIR = join(__dirname, '../../public/dossies');
const DELAY_MS = 2 * 60 * 1000; // TEMPORÁRIO — trocar para 15 * 60 * 1000 após validar

if (!existsSync(DOSSIES_DIR)) {
  mkdirSync(DOSSIES_DIR, { recursive: true });
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
  const perfil = (body.perfil || 'E')[0].toUpperCase();
  const historico = Array.isArray(body.historico) ? body.historico.join(', ') : body.historico || '';
  const respostas = body.respostas || [];
  const source = body.source || '';

  if (!phone) {
    return res.status(400).json({ error: 'WhatsApp obrigatório' });
  }

  console.log(`📨 Disparo recebido para ${nome} (${phone}) — perfil ${perfil}`);
  res.status(200).json({ received: true, phone });

  const agendarDisparo = async () => {
    try {
      console.log(`🤖 Gerando dossiê para ${nome} (perfil ${perfil})...`);

      const personalizado = await generateDossie({ nome, perfil, historico, respostas, source });
      console.log(`✅ Conteúdo gerado para ${nome}`);

      const html = gerarDossie(perfil, nome, personalizado.identificacaoParagrafo, personalizado.sinaisPersonalizados);
      console.log(`📄 HTML gerado para ${nome}`);

      const slug = `${slugify(nome)}-${Date.now()}`;
      const filename = `${slug}.html`;
      writeFileSync(join(DOSSIES_DIR, filename), html, 'utf-8');

      const url = `https://jornada.tableclinic.com.br/${filename}`;
      const mensagem = `${personalizado.whatsappMessage}\n${url}`;

      console.log(`📤 Enviando para ${phone}: ${url}`);
      await sendMessage(phone, mensagem);
      console.log(`✅ Dossiê enviado para ${nome} (${phone})`);

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
