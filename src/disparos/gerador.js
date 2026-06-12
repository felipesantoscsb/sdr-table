// src/disparos/gerador.js

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadTemplate(perfil) {
  const map = { E: 'emocional', R: 'restritiva', S: 'sobrevivencia', A: 'desconectada' };
  const nome = map[perfil] || 'emocional';
  return readFileSync(join(__dirname, `../../public/dossies/template-${nome}.html`), 'utf-8');
}

// Parágrafo de tier — espelha lógica da página de resultado do quiz
const TIER_PARAGRAPHS = {
  hot: 'Você já investiu antes em soluções sérias. Sabe que não é falta de comprometimento. O que faltou foi trabalhar a camada emocional, que nenhuma das outras abordagens tocou.',
  warm: 'Você já tentou algumas coisas e sabe que força de vontade sozinha não resolve. O Protocolo Raiz começa exatamente onde as outras abordagens pararam.',
  cold: 'Este é um primeiro passo concreto: sem restrições, sem julgamento, sem mais uma lista de regras. Só o trabalho real com o que está por trás do seu padrão com a comida.',
};

export function gerarDossie(perfil, nomeLead, tier, identificacaoParagrafo, sinaisPersonalizados) {
  let html = loadTemplate(perfil);

  console.log(`🎨 Injetando nome: "${nomeLead}" | tier: ${tier || 'n/a'} | perfil: ${perfil}`);

  // 1. Injeta o nome da lead acima do tc-hero-title no hero
  const heroTitleSelector = /<h1 class="tc-hero-title">/;
  if (heroTitleSelector.test(html)) {
    html = html.replace(
      heroTitleSelector,
      `<p style="font-family:'Jost',sans-serif;font-size:0.85rem;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:0.5rem;">${nomeLead}</p>\n    <h1 class="tc-hero-title">`
    );
    console.log(`✅ Nome injetado no hero`);
  } else {
    console.warn(`⚠️ Seletor tc-hero-title não encontrado no template do perfil ${perfil}`);
  }

  // 2. Injeta parágrafo personalizado + parágrafo de tier após tc-abertura-sub
  const tierTexto = TIER_PARAGRAPHS[tier] || TIER_PARAGRAPHS.cold;
  const tierHtml = `\n    <p style="font-family:'Jost',sans-serif;font-size:0.88rem;color:#7a7a7a;line-height:1.75;max-width:480px;margin:1rem auto 0;text-align:center;">${tierTexto}</p>`;

  if (identificacaoParagrafo) {
    html = html.replace(
      /(<p class="tc-abertura-sub">[\s\S]*?<\/p>)/,
      `$1\n    <p style="font-family:'Jost',sans-serif;font-size:0.92rem;color:#3D4A35;line-height:1.8;max-width:520px;margin:1.5rem auto 0;padding:1rem 1.25rem;background:#EDE5D8;border-radius:8px;font-style:italic;text-align:left;">${identificacaoParagrafo}</p>${tierHtml}`
    );
  } else {
    // Sem identificacaoParagrafo: injeta só o tier após tc-abertura-sub
    html = html.replace(
      /(<p class="tc-abertura-sub">[\s\S]*?<\/p>)/,
      `$1${tierHtml}`
    );
  }

  // 3. Substitui até 4 tc-signal-item pelos personalizados (fallback para estáticos)
  const sinais = Array.isArray(sinaisPersonalizados) ? sinaisPersonalizados : [];
  if (sinais.length >= 1) {
    let count = 0;
    html = html.replace(
      /<div class="tc-signal-item"><div class="tc-signal-dot"><\/div><span>([^<]+)<\/span><\/div>/g,
      (match) => {
        if (count < sinais.length && sinais[count]) {
          const sinal = sinais[count];
          count++;
          return `<div class="tc-signal-item"><div class="tc-signal-dot"></div><span>${sinal}</span></div>`;
        }
        return match;
      }
    );
    console.log(`✅ ${count} sinais personalizados injetados`);
  }

  // 4. Substitui placeholder de urgência (configurável via config futura)
  // Default: texto original de cada perfil mantido no template como referência
  const urgenciaDefault = {
    E: 'O ciclo não para de esperar, ele só muda quando você decide intervir nele.',
    R: 'A próxima segunda-feira vai parecer um recomeço. Mas o ciclo não conhece segundas-feiras.',
    S: 'Você não vai ter mais tempo amanhã do que tem hoje. Mas pode ter mais clareza.',
    A: 'A desconexão não resolve com o tempo. Com o tempo, ela se aprofunda.',
  };
  html = html.replace('{{URGENCIA_TEXTO}}', urgenciaDefault[perfil] || urgenciaDefault.E);

  return html;
}
