import axios from 'axios';

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v25.0';
const GRAPH_URL = `https://graph.facebook.com/${API_VERSION}`;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável de ambiente obrigatória não definida: ${name}`);
  return value;
}

function bodyComponents(params = []) {
  const cleanParams = params.map(value => String(value || '').trim());
  if (!cleanParams.length) return undefined;
  return [{
    type: 'body',
    parameters: cleanParams.map(text => ({ type: 'text', text })),
  }];
}

export async function sendOfficialTemplate({ to, templateName, languageCode, params = [] }) {
  const phoneNumberId = requireEnv('WHATSAPP_PHONE_NUMBER_ID');
  const token = requireEnv('WHATSAPP_ACCESS_TOKEN');
  const language = languageCode || process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'pt_BR';
  const components = bodyComponents(params);

  try {
    const response = await axios.post(`${GRAPH_URL}/${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: language },
        ...(components ? { components } : {}),
      },
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    console.log(`✅ Template oficial ${templateName} enviado para ${to}`);
    return response.data;
  } catch (error) {
    const detail = error.response?.data || error.message;
    console.error(`❌ Erro ao enviar template oficial ${templateName} para ${to}:`, detail);
    throw error;
  }
}
