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

  const geocodificar = async (query) => {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&region=br&language=pt-BR&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.status !== 'OK') return null;
    return data.results[0];
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

  const cepEspecifico = (c) => c && c.replace('-', '').slice(-3) !== '000';

  const extrairNumero = (addr) => {
    const match = addr.match(/\b(\d{1,5})\b/);
    return match ? match[1] : null;
  };

  const montarResposta = (tentativa, matchStatus, score, enderecoSolicitado, enderecoConfirmado, lat, lng, extra = {}) => ({
    tentativa,
    match_status: matchStatus,
    match_score: Math.round(score * 100) + '%',
    endereco_solicitado: enderecoSolicitado,
    endereco_confirmado: enderecoConfirmado,
    ...extra,
    ...(matchStatus === 'divergente' ? { aviso: 'Revisão manual necessária' } : {}),
    ...formatarCoordenadas(lat, lng),
  });

  // -------------------

  try {
    const numero = extrairNumero(address);

    // Tentativa 1 — endereço original completo
    const resultado1 = await geocodificar(address);
    if (resultado1) {
      const { lat, lng } = resultado1.geometry.location;
      const confirmado = resultado1.formatted_address;
      const { score, matchStatus } = calcularMatch(address, confirmado);
      if (matchStatus !== 'divergente') {
        return res.status(200).json(montarResposta(1, matchStatus, score, address, confirmado, lat, lng));
      }
    }

    // Tentativa 2 — nome de rua do ViaCEP + número + CEP + cidade
    if (cepEspecifico(cep) && numero) {
      const cepLimpo = cep.replace('-', '');
      const viaCepRes = await fetch(`https://viacep.com.br/ws/${cepLimpo}/json/`);
      const viaCepData = await viaCepRes.json();

      if (!viaCepData.erro) {
        const enderecoCorrigido = `${viaCepData.logradouro}, ${numero}, ${cep}, ${viaCepData.localidade}, ${viaCepData.uf}, Brasil`;
        const resultado2 = await geocodificar(enderecoCorrigido);

        if (resultado2) {
          const { lat, lng } = resultado2.geometry.location;
          const confirmado = resultado2.formatted_address;
          const { score, matchStatus } = calcularMatch(enderecoCorrigido, confirmado);
          if (matchStatus !== 'divergente') {
            return res.status(200).json(
              montarResposta(2, matchStatus, score, address, confirmado, lat, lng, {
                endereco_corrigido_viacep: enderecoCorrigido,
              })
            );
          }
        }

        // Tentativa 3 — só CEP + número, sem nome de rua
        if (numero) {
          const enderecoMinimo = `${numero}, ${cep}, Brasil`;
          const resultado3 = await geocodificar(enderecoMinimo);

          if (resultado3) {
            const { lat, lng } = resultado3.geometry.location;
            const confirmado = resultado3.formatted_address;
            const { score, matchStatus } = calcularMatch(
              `${viaCepData.logradouro} ${numero} ${viaCepData.localidade}`,
              confirmado
            );
            return res.status(200).json(
              montarResposta(3, matchStatus, score, address, confirmado, lat, lng, {
                endereco_corrigido_viacep: enderecoCorrigido,
                endereco_minimo_usado: enderecoMinimo,
                ...(matchStatus === 'divergente' ? {} : { aviso: null }),
              })
            );
          }
        }
      }
    }

    // Todas as tentativas falharam
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