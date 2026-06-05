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

export function gerarDossie(perfil, nomeLead, identificacaoParagrafo, sinaisPersonalizados) {
  let html = loadTemplate(perfil);

  console.log(`🎨 Injetando nome: "${nomeLead}" no perfil ${perfil}`);

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

  // 2. Injeta parágrafo personalizado após tc-abertura-sub
  if (identificacaoParagrafo) {
    html = html.replace(
      /(<p class="tc-abertura-sub">[\s\S]*?<\/p>)/,
      `$1\n    <p style="font-family:'Jost',sans-serif;font-size:0.92rem;color:#3D4A35;line-height:1.8;max-width:520px;margin:1.5rem auto 0;padding:1rem 1.25rem;background:#EDE5D8;border-radius:8px;font-style:italic;text-align:left;">${identificacaoParagrafo}</p>`
    );
  }

  // 3. Substitui os dois primeiros tc-signal-item pelos personalizados
  if (sinaisPersonalizados?.length >= 2) {
    let count = 0;
    html = html.replace(
      /<div class="tc-signal-item"><div class="tc-signal-dot"><\/div><span>([^<]+)<\/span><\/div>/g,
      (match) => {
        if (count < 2 && sinaisPersonalizados[count]) {
          const sinal = sinaisPersonalizados[count];
          count++;
          return `<div class="tc-signal-item"><div class="tc-signal-dot"></div><span>${sinal}</span></div>`;
        }
        return match;
      }
    );
  }

  return html;
}
