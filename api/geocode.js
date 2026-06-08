export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const { address } = req.query;
  if (!address) {
    return res.status(400).json({ error: 'Endereço obrigatório' });
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&region=br&language=pt-BR&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK') {
      return res.status(404).json({ error: 'Endereço não encontrado', status: data.status });
    }

    const { lat, lng } = data.results[0].geometry.location;
    const enderecoConfirmado = data.results[0].formatted_address;

    // --- Comparação de endereços ---
    const normalizar = (str) =>
      str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // remove acentos
        .replace(/[^a-z0-9\s]/g, '')     // remove pontuação
        .split(/\s+/)
        .filter(w => w.length > 2);      // ignora palavras curtas (de, da, sp...)

    const wordsInput = normalizar(address);
    const wordsOutput = normalizar(enderecoConfirmado);

    const matches = wordsInput.filter(w => wordsOutput.includes(w));
    const score = matches.length / wordsInput.length;

    let matchStatus;
    if (score >= 0.6) matchStatus = 'ok';
    else if (score >= 0.3) matchStatus = 'incerto';
    else matchStatus = 'divergente';
    // ---------------------------------

    const toGMS = (decimal) => {
      const abs = Math.abs(decimal);
      const degrees = Math.floor(abs);
      const minFloat = (abs - degrees) * 60;
      const minutes = Math.floor(minFloat);
      const seconds = ((minFloat - minutes) * 60).toFixed(3);
      return { degrees, minutes, seconds };
    };

    const latGMS = toGMS(lat);
    const lngGMS = toGMS(lng);
    const latDir = lat < 0 ? 'S' : 'N';
    const lngDir = lng < 0 ? 'O' : 'L';
    const lngDirW = lng < 0 ? 'W' : 'E';

    return res.status(200).json({
      match_status: matchStatus,
      match_score: Math.round(score * 100) + '%',
      endereco_solicitado: address,
      endereco_confirmado: enderecoConfirmado,
      latitude_decimal: lat,
      longitude_decimal: lng,
      latitude_cpfl: `${latDir} ${latGMS.degrees} ${latGMS.minutes} ${latGMS.seconds}`,
      longitude_cpfl: `${lngDir} ${lngGMS.degrees} ${lngGMS.minutes} ${lngGMS.seconds}`,
      latitude_sirgas: `${latGMS.degrees}º ${latGMS.minutes}'' ${parseFloat(latGMS.seconds).toFixed(1)}' ${latDir}`,
      longitude_sirgas: `${lngGMS.degrees}º ${lngGMS.minutes}'' ${parseFloat(lngGMS.seconds).toFixed(1)}' ${lngDirW}`,
    });

  } catch (error) {
    return res.status(500).json({ error: 'Erro interno', details: error.message });
  }
}