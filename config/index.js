// config/index.js
// Centraliza todas as configurações do sistema.

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Variável de ambiente obrigatória não definida: ${name}`);
  return val;
}

export const config = {
  port: process.env.PORT || 3000,

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: 'claude-sonnet-4-5',
  },

  zapi: {
    instanceId: required('ZAPI_INSTANCE_ID'),
    token: required('ZAPI_TOKEN'),
    clientToken: required('ZAPI_CLIENT_TOKEN'),
    baseUrl: () =>
      `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}`,
  },

  sdr: {
    phone: required('SDR_PHONE'),
  },

  webhook: {
    secret: required('WEBHOOK_SECRET'),
  },

  // 90s — aguarda mais mensagens antes de processar
  aggregationDelay: 90_000,
};
