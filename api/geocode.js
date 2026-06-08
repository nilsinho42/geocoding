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
    const score = matches.length / wordsInput.length;
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

  try {
    // Tentativa 1 — endereço original
    const resultado1 = await geocodificar(address);

    if (!resultado1) {
      return res.status(404).json({ error: 'Endereço não encontrado na tentativa 1' });
    }

    const { lat: lat1, lng: lng1 } = resultado1.geometry.location;
    const confirmado1 = resultado1.formatted_address;
    const { score: score1, matchStatus: status1 } = calcularMatch(address, confirmado1);

    // Retorno imediato se ok ou incerto
    if (status1 !== 'divergente') {
      return res.status(200).json({
        tentativa: 1,
        match_status: status1,
        match_score: Math.round(score1 * 100) + '%',
        endereco_solicitado: address,
        endereco_confirmado: confirmado1,
        ...formatarCoordenadas(lat1, lng1),
      });
    }

    // Tentativa 2 — fallback via ViaCEP se CEP específico
    if (!cepEspecifico(cep)) {
      return res.status(200).json({
        tentativa: 1,
        match_status: 'divergente',
        match_score: Math.round(score1 * 100) + '%',
        endereco_solicitado: address,
        endereco_confirmado: confirmado1,
        aviso: 'CEP ausente ou genérico — revisão manual necessária',
        ...formatarCoordenadas(lat1, lng1),
      });
    }

    const cepLimpo = cep.replace('-', '');
    const viaCepRes = await fetch(`https://viacep.com.br/ws/${cepLimpo}/json/`);
    const viaCepData = await viaCepRes.json();

    if (viaCepData.erro) {
      return res.status(200).json({
        tentativa: 1,
        match_status: 'divergente',
        match_score: Math.round(score1 * 100) + '%',
        endereco_solicitado: address,
        endereco_confirmado: confirmado1,
        aviso: 'CEP não encontrado no ViaCEP — revisão manual necessária',
        ...formatarCoordenadas(lat1, lng1),
      });
    }

    const numero = extrairNumero(address);
    const enderecoCorrigido = `${viaCepData.logradouro}, ${numero}, ${cepLimpo}, ${viaCepData.localidade}, ${viaCepData.uf}`;

    const resultado2 = await geocodificar(enderecoCorrigido);

    if (!resultado2) {
      return res.status(200).json({
        tentativa: 2,
        match_status: 'divergente',
        match_score: '0%',
        endereco_solicitado: address,
        endereco_corrigido_viacep: enderecoCorrigido,
        endereco_confirmado: confirmado1,
        aviso: 'Tentativa com ViaCEP também falhou — revisão manual necessária',
        ...formatarCoordenadas(lat1, lng1),
      });
    }

    const { lat: lat2, lng: lng2 } = resultado2.geometry.location;
    const confirmado2 = resultado2.formatted_address;
    const { score: score2, matchStatus: status2 } = calcularMatch(enderecoCorrigido, confirmado2);

    return res.status(200).json({
      tentativa: 2,
      match_status: status2,
      match_score: Math.round(score2 * 100) + '%',
      endereco_solicitado: address,
      endereco_corrigido_viacep: enderecoCorrigido,
      endereco_confirmado: confirmado2,
      aviso: status2 === 'divergente' ? 'Revisão manual necessária' : null,
      ...formatarCoordenadas(lat2, lng2),
    });

  } catch (error) {
    return res.status(500).json({ error: 'Erro interno', details: error.message });
  }
}