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

  const geocodificar = async (addr) => {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(addr)}&region=br&language=pt-BR&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.status !== 'OK') return null;
    return data.results[0];
  };

  const isConfiavel = (resultado) => {
    if (!resultado) return false;
    return (
      !resultado.partial_match &&
      ['ROOFTOP', 'RANGE_INTERPOLATED'].includes(resultado.geometry?.location_type)
    );
  };

  const gerarVariacoes = (palavra) => {
    const variações = new Set();
    const base = palavra.toLowerCase();
    const vogais = ['a', 'e', 'i', 'o'];

    const trocaVogalFinal = (str) => {
      const chars = str.split('');
      for (let i = chars.length - 1; i >= 0; i--) {
        if (vogais.includes(chars[i])) {
          for (const v of vogais) {
            if (v !== chars[i]) {
              const nova = [...chars];
              nova[i] = v;
              variações.add(nova.join(''));
            }
          }
          break;
        }
      }
    };

    const trocaZS = (str) => {
      if (str.includes('z')) variações.add(str.replaceAll('z', 's'));
      if (str.includes('s')) variações.add(str.replaceAll('s', 'z'));
    };

    trocaVogalFinal(base);
    trocaZS(base);

    const comZS = base.includes('z')
      ? base.replaceAll('z', 's')
      : base.replaceAll('s', 'z');
    trocaVogalFinal(comZS);

    variações.delete(base);
    return [...variações].slice(0, 10);
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

    // Tentativa 1 — endereço original
    const resultado1 = await geocodificar(address);
    if (resultado1 && isConfiavel(resultado1)) {
      const { lat, lng } = resultado1.geometry.location;
      const confirmado = resultado1.formatted_address;
      const { score, matchStatus } = calcularMatch(address, confirmado);
      return res.status(200).json(
        montarResposta(1, 'geocoding-original', true, matchStatus, score, address, confirmado, lat, lng)
      );
    }

    // Tentativa 2 — variações de grafia da última palavra via ViaCEP
    if (cep) {
      const cepLimpo = cep.replace(/\D/g, '');
      const viaCepRes = await fetch(`https://viacep.com.br/ws/${cepLimpo}/json/`);
      const viaCepData = await viaCepRes.json();

      if (!viaCepData.erro && viaCepData.logradouro && numero) {
        const palavras = viaCepData.logradouro.split(' ');
        const ultimaPalavra = palavras[palavras.length - 1];
        const prefixo = palavras.slice(0, -1).join(' ');
        const variações = gerarVariacoes(ultimaPalavra);

        for (const variação of variações) {
          const enderecoVariação = `${prefixo} ${variação}, ${numero}, ${viaCepData.localidade}, ${viaCepData.uf}, Brasil`;
          const resultado = await geocodificar(enderecoVariação);

          if (resultado && isConfiavel(resultado)) {
            const { lat, lng } = resultado.geometry.location;
            const confirmado = resultado.formatted_address;
            const { score, matchStatus } = calcularMatch(address, confirmado);
            return res.status(200).json(
              montarResposta(2, `variação-grafia:${variação}`, true, matchStatus, score, address, confirmado, lat, lng, {
                endereco_corrigido: enderecoVariação,
              })
            );
          }
        }
      }
    }

    // Tentativa 3 — melhor resultado disponível com flag de revisão
    const melhor = resultado1;
    if (melhor) {
      const { lat, lng } = melhor.geometry.location;
      const confirmado = melhor.formatted_address;
      const { score, matchStatus } = calcularMatch(address, confirmado);
      return res.status(200).json(
        montarResposta(3, 'melhor-disponivel', false, matchStatus, score, address, confirmado, lat, lng)
      );
    }

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