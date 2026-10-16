// Transcrição de áudio recebido no inbound.
//
// Portado do repo da LIA (src/providers/transcription), que já roda isso em
// produção. O que importa do que foi aprendido lá:
//
//   - O áudio do WhatsApp chega em ogg/opus e o Whisper aceita DIRETO. Sem
//     ffmpeg no caminho, o que mantém o deploy leve.
//   - Nota de voz vem em `ptt` (push-to-talk), não em `audio`. Ler só `audio`
//     perde justamente o caso comum.
//   - O texto transcrito NUNCA vai para o log: é relato de comportamento
//     alimentar, o dado mais sensível que passa por aqui.
//   - Sem chave configurada o fluxo não quebra: a lead recebe um pedido para
//     escrever, que é melhor que silêncio e melhor que adivinhação.
//
// Chamada por fetch puro na API da OpenAI: não vale uma dependência nova no
// serviço só para montar um multipart de três campos.

const MODELO = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';
const IDIOMA = process.env.TRANSCRICAO_IDIOMA || 'pt';
const LIMITE_BYTES = 25 * 1024 * 1024; // teto da API

export function transcricaoDisponivel() {
  return Boolean(process.env.OPENAI_API_KEY) && process.env.TRANSCRICAO_ENABLED !== 'false';
}

/** Áudio no payload da Z-API, em qualquer uma das duas formas. */
export function audioDoPayload(body = {}) {
  const fonte = body.audio || body.ptt || null;
  if (!fonte) return null;
  const url = fonte.audioUrl || fonte.url || null;
  if (!url) return null;
  return { url, mimeType: fonte.mimeType || 'audio/ogg' };
}

async function baixar(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`download do áudio falhou: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > LIMITE_BYTES) throw new Error(`áudio grande demais: ${buffer.length} bytes`);
  if (!buffer.length) throw new Error('áudio vazio');
  return { buffer, mimeType: res.headers.get('content-type') || null };
}

/**
 * Devolve o texto, ou null. NUNCA lança: falha de transcrição não pode
 * derrubar o atendimento — o chamador pede para a lead escrever.
 */
export async function transcrever({ url, mimeType }) {
  if (!transcricaoDisponivel()) {
    console.warn('[transcricao] pulada — OPENAI_API_KEY ausente ou desligada');
    return null;
  }
  try {
    const baixado = await baixar(url);
    const tipo = baixado.mimeType || mimeType || 'audio/ogg';

    const form = new FormData();
    form.append('model', MODELO);
    form.append('language', IDIOMA);
    form.append('response_format', 'json');
    form.append('file', new Blob([new Uint8Array(baixado.buffer)], { type: tipo }), 'audio.ogg');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.error(`[transcricao] OpenAI recusou: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const texto = typeof data?.text === 'string' ? data.text.trim() : '';
    // Só o tamanho no log. O conteúdo não sai daqui.
    console.log(`[transcricao] ok — ${texto.length} caracteres`);
    // Transcrição de um ruído costuma vir com duas ou três letras. Tratar isso
    // como fala faria o agente responder ao nada.
    return texto.length >= 4 ? texto : null;
  } catch (err) {
    console.error(`[transcricao] falhou: ${err.message}`);
    return null;
  }
}

export const PEDIDO_DE_TEXTO =
  'Recebi seu áudio, mas não consegui escutar direito agora. Consegue me mandar por escrito? Pode ser bem resumido.';
