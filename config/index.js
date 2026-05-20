// config/index.js
// Centraliza todas as configurações do sistema.
// Motivo: se um valor mudar, você muda em UM lugar só.

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`❌ Variável de ambiente obrigatória não definida: ${name}`);
  return val;
}

export const config = {
  port: process.env.PORT || 3000,

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: 'claude-sonnet-4-20250514',
  },

  zapi: {
    instanceId: required('ZAPI_INSTANCE_ID'),
    token: required('ZAPI_TOKEN'),
    clientToken: required('ZAPI_CLIENT_TOKEN'),
    // URL base da Zapi — não mude isso
    baseUrl: () =>
      `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_TOKEN}`,
  },

  sdr: {
    phone: required('SDR_PHONE'),
  },

  webhook: {
    secret: required('WEBHOOK_SECRET'),
  },

  // Timer de agregação de mensagens (ms)
  // Motivo: leads costumam mandar várias mensagens curtas seguidas.
  // Esperamos 30s para juntar tudo antes de processar.
  aggregationDelay: 30_000,
};
