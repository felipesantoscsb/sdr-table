export class InvalidGeneratedReplyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidGeneratedReplyError';
  }
}

export function anthropicText(response) {
  return (response?.content || [])
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim();
}

/**
 * Tira da mensagem da lead as marcas que denunciam texto gerado: travessao,
 * hifen usado como pontuacao e marcador de lista.
 *
 * A regra existe no prompt do inbound E em anthropic.js desde sempre, e
 * mesmo assim travessao continuou chegando na lead. Instrucao negativa nao
 * segura formatacao: o modelo escreve travessao porque e natural escrever
 * travessao. Aqui e deterministico.
 *
 * Hifen DENTRO da palavra fica intacto: pre-consulta, segunda-feira,
 * bem-estar. So sai o que esta cercado de espaco, que e uso de pontuacao.
 */
export function humanizarPontuacao(texto) {
  if (typeof texto !== 'string' || !texto) return texto;

  return texto
    // Marcador de lista no inicio da linha. Lista no WhatsApp parece formulario.
    .replace(/^[ \t]*[-–—•*]+[ \t]+/gm, '')
    // Travessao ou hifen como pontuacao, cercado de espaco.
    .replace(/[ \t]*[—–][ \t]*/g, ', ')
    .replace(/[ \t]+-[ \t]+/g, ', ')
    // Sobras: virgula encostando em outra pontuacao, ou no fim da frase.
    .replace(/,\s*([,.;:!?])/g, '$1')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/,(\s*\n)/g, '.$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/,\s*$/g, '')
    .trim();
}

export function parseGeneratedReply(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new InvalidGeneratedReplyError('A IA retornou conteúdo vazio');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/gi, '').trim());
  } catch {
    throw new InvalidGeneratedReplyError('A IA não retornou JSON válido');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidGeneratedReplyError('A IA retornou um formato inválido');
  }

  const redflag = parsed.redflag === true;
  const leadMessage = typeof parsed.leadMessage === 'string'
    ? humanizarPontuacao(parsed.leadMessage)
    : '';

  // Em red flag não há mensagem para a lead: o fluxo para e chama a SDR.
  // Em todos os outros casos uma resposta vazia é inválida e deve ser gerada
  // novamente antes de chegar à Z-API.
  if (!redflag && !leadMessage) {
    throw new InvalidGeneratedReplyError('A IA não preencheu leadMessage');
  }

  return {
    ...parsed,
    leadMessage,
    sdrBriefing: typeof parsed.sdrBriefing === 'string' ? parsed.sdrBriefing.trim() : '',
    handoff: parsed.handoff === true,
    handoffTurno: typeof parsed.handoffTurno === 'string' ? parsed.handoffTurno.trim() : '',
    redflag,
    redflagMotivo: typeof parsed.redflagMotivo === 'string' ? parsed.redflagMotivo.trim() : '',
    evelynEvent: typeof parsed.evelynEvent === 'string' ? parsed.evelynEvent.trim() : '',
  };
}

export function sanitizeConversationHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(item => item && (item.role === 'user' || item.role === 'assistant'))
    .filter(item => typeof item.content === 'string' && item.content.trim())
    .map(item => ({ role: item.role, content: item.content.trim() }));
}

export function manualReviewFallback(mode = 'sdr') {
  const leadMessage = mode === 'recovery'
    ? 'Entendi. Obrigada por me contar. Vou verificar isso com a equipe e já seguimos com você por aqui.'
    : 'Entendi. Obrigada por me contar. Vou conversar com a equipe e já seguimos com você por aqui.';

  return {
    leadMessage,
    sdrBriefing: 'A resposta automática veio inválida em duas tentativas. A lead recebeu uma mensagem de continuidade e a conversa foi pausada para revisão manual.',
    handoff: false,
    handoffTurno: '',
    redflag: false,
    redflagMotivo: '',
    evelynEvent: '',
    needsManualReview: true,
  };
}
