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

/**
 * Gera o HTML do plano de ação personalizado.
 * Injeta parágrafo de identificação e dois sinais personalizados.
 */
export function gerarDossie(perfil, nome, identificacaoParagrafo, sinaisPersonalizados) {
  let html = loadTemplate(perfil);

  // Substitui "Bem-vinda," pelo nome da lead
  html = html.replace(
    /<h1 class="hero-h1">Bem-vinda,/,
    `<h1 class="hero-h1">Bem-vinda, <em style="font-size:0.7em;opacity:0.85">${nome}.</em><br style="display:none">`
  );

  // Injeta parágrafo personalizado após o segundo .bv-text (mensagem da equipe)
  if (identificacaoParagrafo) {
    html = html.replace(
      /(<p class="bv-text"><strong[^<]*<\/strong>[^<]*<\/p>)/,
      `$1\n    <p class="bv-text" style="background:var(--warm);border-left:3px solid var(--terra);padding:14px 18px;border-radius:0 8px 8px 0;font-style:italic;color:var(--brown)">${identificacaoParagrafo}</p>`
    );
  }

  // Substitui os dois primeiros bp-t (boas práticas) pelos personalizados
  if (sinaisPersonalizados?.length >= 2) {
    let count = 0;
    html = html.replace(
      /<p class="bp-t">([^<]+)<\/p>/g,
      (match, texto) => {
        if (count < 2 && sinaisPersonalizados[count]) {
          const replacement = `<p class="bp-t" style="color:var(--terra)">${sinaisPersonalizados[count]}</p>`;
          count++;
          return replacement;
        }
        return match;
      }
    );
  }

  return html;
}
