export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Não autorizado' });
  }

  const { cep, numero } = req.query;
  if (!cep) return res.status(400).json({ error: 'CEP obrigatório' });

  const cepLimpo = cep.replace(/\D/g, '');
  const results = {};

  // 1 — ViaCEP
  try {
    const r = await fetch(`https://viacep.com.br/ws/${cepLimpo}/json/`);
    results.viacep = await r.json();
  } catch (e) {
    results.viacep = { error: e.message };
  }

  // 2 — Google Geocoding só com CEP
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${cepLimpo}&region=br&language=pt-BR&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const r = await fetch(url);
    results.geocoding_cep_only = await r.json();
  } catch (e) {
    results.geocoding_cep_only = { error: e.message };
  }

  // 3 — Google Geocoding com CEP + número via components
  if (numero) {
    try {
      const components = encodeURIComponent(`postal_code:${cepLimpo}|country:BR`);
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${numero}&components=${components}&region=br&language=pt-BR&key=${process.env.GOOGLE_MAPS_API_KEY}`;
      const r = await fetch(url);
      results.geocoding_cep_plus_number = await r.json();
    } catch (e) {
      results.geocoding_cep_plus_number = { error: e.message };
    }
  }

  // 4 — Address Validation só com CEP + número (sem logradouro)
  if (numero) {
    try {
      const payload = {
        address: {
          regionCode: 'BR',
          postalCode: cepLimpo,
          addressLines: [numero],
        },
      };
      const r = await fetch(
        `https://addressvalidation.googleapis.com/v1:validateAddress?key=${process.env.GOOGLE_MAPS_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      );
      results.address_validation_no_hint = await r.json();
    } catch (e) {
      results.address_validation_no_hint = { error: e.message };
    }
  }

  // 5 — Address Validation com logradouro do ViaCEP como hint
  if (numero && results.viacep?.logradouro) {
    try {
      const payload = {
        address: {
          regionCode: 'BR',
          postalCode: cepLimpo,
          addressLines: [`${results.viacep.logradouro}, ${numero}`],
        },
      };
      const r = await fetch(
        `https://addressvalidation.googleapis.com/v1:validateAddress?key=${process.env.GOOGLE_MAPS_API_KEY}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      );
      results.address_validation_with_viacep_hint = await r.json();
    } catch (e) {
      results.address_validation_with_viacep_hint = { error: e.message };
    }
  }

  return res.status(200).json(results);
}