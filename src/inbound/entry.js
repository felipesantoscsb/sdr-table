// Porta de entrada do WhatsApp inbound (anúncio e story).
//
// O problema: a instância Z-API da satisfação tem UM webhook de entrada só, e
// ela já manda pesquisa de satisfação e lembrete do formulário do PR, as duas
// dizendo "é só responder por aqui". Então chega resposta de pesquisa no mesmo
// lugar que chega lead nova de anúncio, e confundir as duas seria o pior
// resultado possível: paciente respondendo pesquisa vira lead de captação.
//
// A separação é feita pelo texto pré-preenchido do link (wa.me/...?text=...),
// o mesmo mecanismo da FRASE_QUIZ que já roda há meses no número da Karina.
// Quem vem do anúncio manda a frase; quem responde pesquisa, não. O que não
// casar aqui NÃO entra no agente — é repassado para o Hub, onde já existe o
// caminho que avisa a Karina.

// Núcleo distintivo da frase. É o que precisa aparecer na mensagem; o resto
// (saudação antes, emoji depois) não importa. Deliberadamente longo e
// específico: resposta de pesquisa não acerta isso por acidente.
const NUCLEO = 'quero saber mais sobre o acompanhamento da table clinic';

// Normaliza para comparar: sem acento, sem caixa, sem pontuação, espaço único.
// A pessoa pode editar a frase no WhatsApp antes de mandar, e o celular dela
// pode trocar as aspas.
export function normalizarTexto(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Link de anúncio e de story usam a MESMA frase núcleo com uma palavra de
// origem diferente, para a atribuição não depender de UTM (que não existe no
// WhatsApp).
const ORIGENS = [
  { origem: 'anuncio', marcas: ['vim pelo anuncio', 'vi o anuncio', 'pelo anuncio'] },
  { origem: 'story',   marcas: ['vim pelo story', 'vim pelos stories', 'pelo story', 'pelos stories'] },
  { origem: 'bio',     marcas: ['vim pela bio', 'pelo perfil', 'pela bio'] },
];

/**
 * Click-to-WhatsApp do Meta: quando o plano da Z-API entrega o bloco de
 * referral, ele traz o anúncio de origem. É um bônus de atribuição, nunca um
 * requisito — o fluxo inteiro funciona sem isto.
 */
export function extrairCtwa(body = {}) {
  const ref = body.referral || body.referralAd || body.adReferral || null;
  const clid = body.ctwaClid || body.ctwa_clid || ref?.ctwaClid || ref?.ctwa_clid || null;
  const sourceId = ref?.sourceId || ref?.source_id || ref?.adId || ref?.ad_id || null;
  if (!ref && !clid && !sourceId) return null;
  return {
    ctwaClid: clid || null,
    sourceId: sourceId || null,
    sourceType: ref?.sourceType || ref?.source_type || null,
    headline: ref?.headline || ref?.body || null,
  };
}

/**
 * Decide se esta mensagem abre uma conversa do inbound.
 *
 * Casa por CONTEÚDO (o núcleo da frase) ou por REFERRAL do click-to-WhatsApp.
 * Qualquer outra coisa devolve match false e segue para o repasse ao Hub.
 */
export function detectarEntrada(body = {}, texto = '') {
  const ctwa = extrairCtwa(body);
  const norm = normalizarTexto(texto);
  const temNucleo = norm.includes(NUCLEO);

  if (!temNucleo && !ctwa) return { match: false, origem: null, ctwa: null };

  let origem = null;
  for (const o of ORIGENS) {
    if (o.marcas.some(m => norm.includes(m))) { origem = o.origem; break; }
  }
  // Sem palavra de origem na frase: se o Meta mandou referral, é anúncio;
  // senão é link direto (bio, print compartilhado, alguém que copiou a frase).
  if (!origem) origem = ctwa ? 'anuncio' : 'direto';

  return { match: true, origem, ctwa, viaReferral: !temNucleo && !!ctwa };
}

export const NUCLEO_FRASE = NUCLEO;

// Frases prontas para montar os links. Mantidas aqui porque o link do anúncio
// e o matcher têm de mudar juntos: se divergirem, a lead cai no repasse.
export const FRASES = {
  anuncio: 'Oi! Vim pelo anúncio e quero saber mais sobre o acompanhamento da Table Clinic',
  story:   'Oi! Vim pelo story e quero saber mais sobre o acompanhamento da Table Clinic',
  bio:     'Oi! Vim pela bio e quero saber mais sobre o acompanhamento da Table Clinic',
};
