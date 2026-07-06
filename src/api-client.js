import { stateForCity } from './geo.js';

/**
 * Client for the SLE public JSON API. All Portuguese API fields are mapped to
 * the English domain model here, at the boundary — nothing Portuguese leaves
 * this module except data values.
 */

/** Parse a notice id like "0717700/000002/2026" into its parts. */
export function parseNoticeId(noticeId) {
  const [unitCode, number, year] = String(noticeId).split('/');
  if (!unitCode || !number || !year) throw new Error(`malformed notice id: ${noticeId}`);
  return { unitCode, number, year };
}

/** Map one entry of api/editais-disponiveis to a notice summary. */
export function mapNoticeSummary(raw, statusCode) {
  const { unitCode, number, year } = parseNoticeId(raw.edital);
  return {
    noticeId: raw.edital,
    shortId: raw.edle,
    unitCode,
    number,
    year,
    unitName: raw.uaNm ?? null,
    city: raw.cidade ?? null,
    state: stateForCity(raw.cidade) ?? stateForCity(raw.uaNm),
    statusCode: raw.codigoSituacao ?? statusCode,
    allowsIndividuals: Boolean(raw.permitePF),
    proposalsStartAt: raw.dataInicioPropostas ?? null,
    proposalsEndAt: raw.dataFimPropostas ?? null,
    biddingStartsAt: raw.dataAberturaLances ?? null,
    lotCount: raw.lotes ?? null,
  };
}

/** Map one lot from a notice detail's listaLotes. */
export function mapLotSummary(raw, noticeId) {
  const thumbnail = Array.isArray(raw.imagens) && raw.imagens.length > 0
    ? (raw.imagens[0].min ?? raw.imagens[0].src ?? null)
    : null;
  return {
    noticeId,
    lotNumber: raw.nrAtribuido ?? raw.loleNrSq,
    category: raw.tipo ?? null,
    minBid: raw.valorMinimo ?? null,
    appraisalValue: raw.valorAvaliacao ?? null,
    lotStatusCode: raw.situacaoLote ?? null,
    featured: Boolean(raw.destaque),
    allowsIndividuals: Boolean(raw.permitePF),
    hasImages: Boolean(raw.possuiImagens) || Boolean(thumbnail),
    thumbnailUrl: thumbnail,
  };
}

/** Map a lot detail's itensDetalhesLote to items. */
export function mapLotItems(raw) {
  return (raw.itensDetalhesLote ?? []).map((item) => ({
    description: item.descricao ?? null,
    quantity: item.quantidade ?? null,
    unit: item.unMedida ?? null,
    warehouse: item.recintoArmazenador ?? null,
  }));
}

export function createSleClient({
  fetchImpl = fetch,
  baseUrl,
  userAgent,
  requestSpacingMs = 500,
  maxRetries = 2,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  let lastRequestAt = 0;

  async function request(path) {
    const wait = lastRequestAt + requestSpacingMs - Date.now();
    if (wait > 0) await sleep(wait);

    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      lastRequestAt = Date.now();
      try {
        const response = await fetchImpl(`${base}${path}`, {
          headers: { 'User-Agent': userAgent, Accept: 'application/json' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
        return await response.json();
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries) await sleep(requestSpacingMs * 2 ** (attempt + 1));
      }
    }
    throw lastError;
  }

  return {
    /** All notices grouped by status → flat list of notice summaries. */
    async fetchNoticesList() {
      const data = await request('api/editais-disponiveis');
      const notices = [];
      for (const group of data.situacoes ?? []) {
        for (const raw of group.lista ?? []) {
          notices.push(mapNoticeSummary(raw, group.situacao));
        }
      }
      return { fetchedAt: data.agora ?? null, notices };
    },

    /** Notice detail → lot summaries. */
    async fetchNoticeLots(noticeId) {
      const { unitCode, number, year } = parseNoticeId(noticeId);
      const data = await request(`api/edital/${unitCode}/${number}/${year}`);
      return (data.listaLotes ?? []).map((raw) => mapLotSummary(raw, noticeId));
    },

    /** Lot detail → items. */
    async fetchLotItems(noticeId, lotNumber) {
      const { unitCode, number, year } = parseNoticeId(noticeId);
      const data = await request(`api/lote/${unitCode}/${number}/${year}/${lotNumber}`);
      return mapLotItems(data);
    },
  };
}
