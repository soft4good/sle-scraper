import { normalizeText } from './text.js';

// Brazilian fiscal regions (Regiões Fiscais da RFB) → member states.
export const FISCAL_REGION_STATES = {
  1: ['DF', 'GO', 'MT', 'MS', 'TO'],
  2: ['AC', 'AM', 'AP', 'PA', 'RO', 'RR'],
  3: ['CE', 'MA', 'PI'],
  4: ['AL', 'PB', 'PE', 'RN'],
  5: ['BA', 'SE'],
  6: ['MG'],
  7: ['ES', 'RJ'],
  8: ['SP'],
  9: ['PR', 'SC'],
  10: ['RS'],
};

// Headquarters state of each regional superintendence.
const FISCAL_REGION_HQ_STATE = {
  1: 'DF', 2: 'PA', 3: 'CE', 4: 'PE', 5: 'BA',
  6: 'MG', 7: 'RJ', 8: 'SP', 9: 'PR', 10: 'RS',
};

// Cities / executing-unit names as they appear in the SLE API (values are data,
// hence Portuguese). Keys are stored normalized (accent-stripped, uppercase).
const CITY_STATE_ENTRIES = {
  'AEROPORTO INTERNACIONAL DE BRASÍLIA': 'DF',
  'AEROPORTO INTERNACIONAL DE SALVADOR DEP.LUÍS EDUARDO MAGALHÃES': 'BA',
  'AEROPORTO INTERNACIONAL DE SÃO PAULO': 'SP',
  'AEROPORTO INTERNACIONAL DE VIRACOPOS': 'SP',
  'AEROPORTO INTERNACIONAL DO GALEÃO': 'RJ',
  'AEROPORTO INTERNACIONAL DOS GUARARAPES': 'PE',
  'AEROPORTO INTERNACIONAL EDUARDO GOMES': 'AM',
  'ARAÇATUBA': 'SP',
  'ARARAQUARA': 'SP',
  'BAURU': 'SP',
  'BELÉM': 'PA',
  'BELO HORIZONTE': 'MG',
  'BOA VISTA': 'RR',
  'BRASÍLIA': 'DF',
  'CAMPO GRANDE': 'MS',
  'CAMPINAS': 'SP',
  'CASCAVEL': 'PR',
  'CAXIAS DO SUL': 'RS',
  'CHUÍ': 'RS',
  'COPOL - COORDENAÇÃO-GERAL DE PROGRAMAÇÃO E LOGÍSTICA': 'DF',
  'CORUMBÁ': 'MS',
  'CUIABÁ': 'MT',
  'CURITIBA': 'PR',
  'FLORIANÓPOLIS': 'SC',
  'FORTALEZA': 'CE',
  'FOZ DO IGUAÇU': 'PR',
  'FRANCA': 'SP',
  'GOIÂNIA': 'GO',
  'GUARULHOS': 'SP',
  'ITAGUAÍ': 'RJ',
  'ITAJAÍ': 'SC',
  'JOAÇABA': 'SC',
  'JOÃO PESSOA': 'PB',
  'JUNDIAÍ': 'SP',
  'LAGES': 'SC',
  'LONDRINA': 'PR',
  'MACAÉ': 'RJ',
  'MACAPÁ': 'AP',
  'MANAUS': 'AM',
  'MARÍLIA': 'SP',
  'MARINGÁ': 'PR',
  'MONTES CLAROS': 'MG',
  'MUNDO NOVO': 'MS',
  'NATAL': 'RN',
  'NITERÓI': 'RJ',
  'NOVA IGUAÇU': 'RJ',
  'NOVO HAMBURGO': 'RS',
  'PARANAGUÁ': 'PR',
  'PASSO FUNDO': 'RS',
  'PELOTAS': 'RS',
  'PIRACICABA': 'SP',
  'PONTA GROSSA': 'PR',
  'PONTA PORÃ': 'MS',
  'PORTO ALEGRE': 'RS',
  'PORTO DE ITAGUAÍ': 'RJ',
  'PORTO DE ITAJAÍ': 'SC',
  'PORTO DE MANAUS': 'AM',
  'PORTO DE PARANAGUÁ': 'PR',
  'PORTO DE PECÉM': 'CE',
  'PORTO DE RIO GRANDE': 'RS',
  'PORTO DE SANTOS': 'SP',
  'PORTO DE SÃO FRANCISCO DO SUL': 'SC',
  'PORTO DE SAO LUIS': 'MA',
  'PORTO DE SUAPE': 'PE',
  'PORTO DE VITÓRIA': 'ES',
  'PORTO DO RIO DE JANEIRO': 'RJ',
  'PORTO VELHO': 'RO',
  'PRESIDENTE PRUDENTE': 'SP',
  'RECIFE': 'PE',
  'RIBEIRÃO PRETO': 'SP',
  'RIO BRANCO': 'AC',
  'RIO DE JANEIRO': 'RJ',
  'RIO GRANDE': 'RS',
  'SALVADOR': 'BA',
  'SANTA CRUZ DO SUL': 'RS',
  'SANTA MARIA': 'RS',
  'SANTANA DO LIVRAMENTO': 'RS',
  'SANTARÉM': 'PA',
  'SANTO ÂNGELO': 'RS',
  'SANTOS': 'SP',
  'SÃO FRANCISCO DO SUL': 'SC',
  'SÃO JOSÉ DO RIO PRETO': 'SP',
  'SÃO JOSÉ DOS CAMPOS': 'SP',
  'SÃO LUÍS': 'MA',
  'SÃO PAULO': 'SP',
  'SOROCABA': 'SP',
  'TAUBATÉ': 'SP',
  'UBERABA': 'MG',
  'URUGUAIANA': 'RS',
  'VITÓRIA': 'ES',
  'VITÓRIA DA CONQUISTA': 'BA',
  'VOLTA REDONDA': 'RJ',
};

const CITY_STATE = new Map(
  Object.entries(CITY_STATE_ENTRIES).map(([city, state]) => [normalizeText(city), state]),
);

const REGION_NAME_PATTERN = /(\d{1,2})ª REGIAO FISCAL/;

/**
 * Resolve the state (UF) for a city / executing-unit name as returned by the
 * SLE API. Returns null when unknown.
 */
export function stateForCity(cityName) {
  const normalized = normalizeText(cityName);
  if (!normalized) return null;
  const direct = CITY_STATE.get(normalized);
  if (direct) return direct;
  const regionMatch = normalized.match(REGION_NAME_PATTERN);
  if (regionMatch) return FISCAL_REGION_HQ_STATE[Number(regionMatch[1])] ?? null;
  return null;
}

/**
 * Fiscal region number from a 7-digit RFB unit code (e.g. "0900100" → 9,
 * "1010100" → 10). Returns null if the code doesn't yield a valid region.
 */
export function fiscalRegionForUnitCode(unitCode) {
  const digits = String(unitCode ?? '').trim();
  if (!/^\d{7}$/.test(digits)) return null;
  const region = Number(digits.slice(0, 2));
  return FISCAL_REGION_STATES[region] ? region : null;
}

/** Candidate states for a notice: resolved state, or its fiscal region's states. */
export function candidateStates(city, unitCode) {
  const state = stateForCity(city);
  if (state) return [state];
  const region = fiscalRegionForUnitCode(unitCode);
  return region ? FISCAL_REGION_STATES[region] : [];
}
