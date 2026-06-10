export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const { address, cep } = req.query;
  if (!address) {
    return res.status(400).json({ error: 'Endereço obrigatório' });
  }

  // --- Utilitários ---

  const normalizar = (str) =>
    str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2);

  const calcularMatch = (input, output) => {
    const wordsInput = normalizar(input);
    const wordsOutput = normalizar(output);
    const matches = wordsInput.filter(w => wordsOutput.includes(w));
    const score = wordsInput.length > 0 ? matches.length / wordsInput.length : 0;
    let matchStatus;
    if (score >= 0.6) matchStatus = 'ok';
    else if (score >= 0.3) matchStatus = 'incerto';
    else matchStatus = 'divergente';
    return { score, matchStatus };
  };

  const geocodificar = async (addr, components = null) => {
    let url = `https://maps.googleapis.com/maps/api/geocode/json?region=br&language=pt-BR&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    if (addr) url += `&address=${encodeURIComponent(addr)}`;
    if (components) url += `&components=${encodeURIComponent(components)}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.status !== 'OK') return null;
    return data.results[0];
  };

  const validarEndereco = async (numero, cepLimpo, logradouroHint = null) => {
    const addressLines = logradouroHint
      ? [`${logradouroHint}, ${numero}`]
      : [numero];

    const payload = {
      address: {
        regionCode: 'BR',
        postalCode: cepLimpo,
        addressLines,
      },
    };

    const response = await fetch(
      `https://addressvalidation.googleapis.com/v1:validateAddress?key=${process.env.GOOGLE_MAPS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    const data = await response.json();
    if (!data.result) return null;
    return data.result;
  };

  const isResultadoConfiavel = (resultado, numero, cepLimpo) => {
    if (!resultado) return false;
    const getComponent = (types) =>
      resultado.address_components?.find(c => types.every(t => c.types.includes(t)));
    const postalCode = getComponent(['postal_code'])?.long_name?.replace(/\D/g, '');
    const streetNumber = getComponent(['street_number'])?.long_name;
    const locationType = resultado.geometry?.location_type;
    const partialMatch = resultado.partial_match;
    return (
      !partialMatch &&
      ['ROOFTOP', 'RANGE_INTERPOLATED'].includes(locationType) &&
      (!cepLimpo || postalCode === cepLimpo) &&
      (!numero || streetNumber === numero)
    );
  };

  const isValidacaoConfiavel = (result, numero, cepLimpo) => {
    if (!result) return false;
    const verdict = result.verdict;
    const geocode = result.geocode;
    if (!verdict || !geocode?.location) return false;
    const granularidade = verdict.validationGranularity;
    const granularidadesAceitas = ['PREMISE', 'SUB_PREMISE', 'PREMISE_PROXIMITY'];
    return granularidadesAceitas.includes(granularidade);
  };

  const toGMS = (decimal) => {
    const abs = Math.abs(decimal);
    const degrees = Math.floor(abs);
    const minFloat = (abs - degrees) * 60;
    const minutes = Math.floor(minFloat);
    const seconds = ((minFloat - minutes) * 60).toFixed(3);
    return { degrees, minutes, seconds };
  };

  const formatarCoordenadas = (lat, lng) => {
    const latGMS = toGMS(lat);
    const lngGMS = toGMS(lng);
    const latDir = lat < 0 ? 'S' : 'N';
    const lngDir = lng < 0 ? 'O' : 'L';
    const lngDirW = lng < 0 ? 'W' : 'E';
    return {
      latitude_decimal: lat,
      longitude_decimal: lng,
      latitude_cpfl: `${latDir} ${latGMS.degrees} ${latGMS.minutes} ${latGMS.seconds}`,
      longitude_cpfl: `${lngDir} ${lngGMS.degrees} ${lngGMS.minutes} ${lngGMS.seconds}`,
      latitude_sirgas: `${latGMS.degrees}º ${latGMS.minutes}'' ${parseFloat(latGMS.seconds).toFixed(1)}' ${latDir}`,
      longitude_sirgas: `${lngGMS.degrees}º ${lngGMS.minutes}'' ${parseFloat(lngGMS.seconds).toFixed(1)}' ${lngDirW}`,
    };
  };

  const cepEspecifico = (c) => c && c.replace(/\D/g, '').slice(-3) !== '000';

  const extrairNumero = (addr) => {
    const match = addr.match(/\b(\d{1,5})\b/);
    return match ? match[1] : null;
  };

  const montarResposta = (tentativa, metodo, confiavel, matchStatus, score, enderecoSolicitado, enderecoConfirmado, lat, lng, extra = {}) => ({
    tentativa,
    metodo,
    confiavel,
    match_status: matchStatus,
    match_score: Math.round(score * 100) + '%',
    endereco_solicitado: enderecoSolicitado,
    endereco_confirmado: enderecoConfirmado,
    ...extra,
    ...(!confiavel ? { aviso: 'Revisão manual necessária' } : {}),
    ...formatarCoordenadas(lat, lng),
  });

  // -------------------

  try {
    const numero = extrairNumero(address);
    const cepLimpo = cep ? cep.replace(/\D/g, '') : null;

    // Tentativa 1 — Geocoding API com endereço original
    const resultado1 = await geocodificar(address);
    if (resultado1 && isResultadoConfiavel(resultado1, numero, cepLimpo)) {
      const { lat, lng } = resultado1.geometry.location;
      const confirmado = resultado1.formatted_address;
      const { score, matchStatus } = calcularMatch(address, confirmado);
      return res.status(200).json(
        montarResposta(1, 'geocoding-original', true, matchStatus, score, address, confirmado, lat, lng)
      );
    }

    // Tentativa 2 — Address Validation API com CEP + número
    if (cepEspecifico(cep) && numero) {
      // Tenta primeiro sem hint de logradouro
      let validacao = await validarEndereco(numero, cepLimpo);

      // Se não for confiável, tenta com hint do ViaCEP
      if (!isValidacaoConfiavel(validacao, numero, cepLimpo)) {
        const viaCepRes = await fetch(`https://viacep.com.br/ws/${cepLimpo}/json/`);
        const viaCepData = await viaCepRes.json();
        if (!viaCepData.erro && viaCepData.logradouro) {
          validacao = await validarEndereco(numero, cepLimpo, viaCepData.logradouro);
        }
      }

      if (validacao && isValidacaoConfiavel(validacao, numero, cepLimpo)) {
        const { latitude: lat, longitude: lng } = validacao.geocode.location;
        const confirmado = validacao.address.formattedAddress;
        const { score, matchStatus } = calcularMatch(address, confirmado);
        return res.status(200).json(
          montarResposta(2, 'address-validation-api', true, matchStatus, score, address, confirmado, lat, lng, {
            granularidade: validacao.verdict.validationGranularity,
          })
        );
      }
    }

    // Tentativa 3 — Retorna melhor resultado disponível com flag de revisão
    const melhorResultado = resultado1;
    if (melhorResultado) {
      const { lat, lng } = melhorResultado.geometry.location;
      const confirmado = melhorResultado.formatted_address;
      const { score, matchStatus } = calcularMatch(address, confirmado);
      return res.status(200).json(
        montarResposta(3, 'melhor-resultado-disponivel', false, matchStatus, score, address, confirmado, lat, lng)
      );
    }

    // Nada encontrado
    return res.status(404).json({
      error: 'Endereço não encontrado após todas as tentativas',
      endereco_solicitado: address,
      cep_fornecido: cep || null,
      aviso: 'Revisão manual necessária',
    });

  } catch (error) {
    return res.status(500).json({ error: 'Erro interno', details: error.message });
  }
}