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

  // 1. Injeta parágrafo personalizado após o tc-abertura-sub
  if (identificacaoParagrafo) {
    html = html.replace(
      /(<p class="tc-abertura-sub">[\s\S]*?<\/p>)/,
      `$1\n    <p style="font-family:'Jost',sans-serif;font-size:0.92rem;font-weight:400;color:#3D4A35;line-height:1.8;max-width:480px;margin:1.25rem auto 0;padding:1rem 1.25rem;background:#EDE5D8;border-radius:8px;font-style:italic;text-align:left;">${identificacaoParagrafo}</p>`
    );
  }

  // 2. Substitui os dois primeiros sinais pelos personalizados
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
