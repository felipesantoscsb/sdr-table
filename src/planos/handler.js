// src/planos/handler.js
// Processa o comando /plano enviado pela Karina

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { generatePlano } from '../ai/anthropic.js';
import { gerarHTML } from './gerador.js';
import { sendMessage } from '../zapi/sender.js';
import { config } from '../../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLANOS_DIR = join(__dirname, '../../public/planos');

// Garante que a pasta existe
if (!existsSync(PLANOS_DIR)) {
  mkdirSync(PLANOS_DIR, { recursive: true });
}

function slugify(nome) {
  return nome
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function handlePlanoCommand(input) {
  try {
    console.log('📄 Gerando plano...');

    // Chama IA para gerar o conteúdo personalizado
    const dados = await generatePlano(input);

    // Gera o HTML completo
    const html = gerarHTML(dados);

    // Salva o arquivo com slug do nome da lead
    const slug = slugify(dados.nomeLead);
    const filename = `${slug}.html`;
    const filepath = join(PLANOS_DIR, filename);
    writeFileSync(filepath, html, 'utf-8');

    const url = `https://table-production-07c5.up.railway.app/planos/${filename}`;

    console.log(`✅ Plano gerado: ${url}`);

    // Envia o link para a Karina
    await sendMessage(config.sdr.phone, `📄 *Proposta gerada para ${dados.nomeLead}*\n\n${url}`, { skipDelay: true });

  } catch (err) {
    console.error('❌ Erro ao gerar plano:', err.message);
    await sendMessage(config.sdr.phone, `Erro ao gerar a proposta: ${err.message}`, { skipDelay: true });
  }
}
