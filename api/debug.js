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
// 6 — Google Places Text Search (New)
  try {
    const queryText = results.viacep?.logradouro
      ? `${results.viacep.logradouro}, ${numero}, ${results.viacep.localidade}, ${results.viacep.uf}, Brasil`
      : `${cep} ${numero} Brasil`;

    const payload = {
      textQuery: queryText,
      languageCode: 'pt-BR',
      regionCode: 'BR',
    };

    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.addressComponents',
      },
      body: JSON.stringify(payload),
    });

    const rawText = await r.text();
    results.places_text_search_new = {
      http_status: r.status,
      raw_response: rawText,
      parsed: (() => { try { return JSON.parse(rawText); } catch { return null; } })(),
    };
  } catch (e) {
    results.places_text_search_new = { error: e.message };
  }

// 7 — Google dois passos: rua sem número → extrai nome → geocodifica com número
  try {
    const ruaSemNumero = results.viacep?.logradouro
      ? `${results.viacep.logradouro}, ${results.viacep.localidade}, ${results.viacep.uf}, Brasil`
      : null;

    if (ruaSemNumero && numero) {
      const url1 = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(ruaSemNumero)}&region=br&language=pt-BR&key=${process.env.GOOGLE_MAPS_API_KEY}`;
      const r1 = await fetch(url1);
      const data1 = await r1.json();

      results.two_step_passo1 = {
        query: ruaSemNumero,
        status: data1.status,
        formatted: data1.results?.[0]?.formatted_address,
        location_type: data1.results?.[0]?.geometry?.location_type,
        route_component: data1.results?.[0]?.address_components?.find(c => c.types.includes('route'))?.long_name,
      };

      const ruaGoogle = data1.results?.[0]?.address_components?.find(c => c.types.includes('route'))?.long_name;

      if (ruaGoogle) {
        const enderecoFinal = `${ruaGoogle}, ${numero}, ${results.viacep.localidade}, ${results.viacep.uf}, Brasil`;
        const url2 = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(enderecoFinal)}&region=br&language=pt-BR&key=${process.env.GOOGLE_MAPS_API_KEY}`;
        const r2 = await fetch(url2);
        const data2 = await r2.json();

        results.two_step_passo2 = {
          query: enderecoFinal,
          status: data2.status,
          formatted: data2.results?.[0]?.formatted_address,
          location_type: data2.results?.[0]?.geometry?.location_type,
          partial_match: data2.results?.[0]?.partial_match,
          location: data2.results?.[0]?.geometry?.location,
        };
      }
    }
  } catch (e) {
    results.two_step = { error: e.message };
  }
  
// 8 — Variações de grafia da última palavra da rua
  try {
    const gerarVariacoes = (palavra) => {
      const variações = new Set();
      const base = palavra.toLowerCase();

      // Troca vogal final
      const trocaVogalFinal = (str) => {
        const vogais = ['a', 'e', 'i', 'o'];
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

      // Troca z↔s em qualquer posição
      const trocaZS = (str) => {
        if (str.includes('z')) variações.add(str.replaceAll('z', 's'));
        if (str.includes('s')) variações.add(str.replaceAll('s', 'z'));
      };

      trocaVogalFinal(base);
      trocaZS(base);

      // Combinações: troca z↔s + troca vogal final
      const comZS = base.includes('z')
        ? base.replaceAll('z', 's')
        : base.replaceAll('s', 'z');
      trocaVogalFinal(comZS);

      // Remove a palavra original
      variações.delete(base);
      return [...variações].slice(0, 10);
    };

    if (results.viacep?.logradouro && numero) {
      const palavras = results.viacep.logradouro.split(' ');
      const ultimaPalavra = palavras[palavras.length - 1];
      const prefixo = palavras.slice(0, -1).join(' ');
      const variações = gerarVariacoes(ultimaPalavra);

      results.variações_testadas = [];

      for (const variação of variações) {
        const enderecoVariação = `${prefixo} ${variação}, ${numero}, ${results.viacep.localidade}, ${results.viacep.uf}, Brasil`;
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(enderecoVariação)}&region=br&language=pt-BR&key=${process.env.GOOGLE_MAPS_API_KEY}`;
        const r = await fetch(url);
        const data = await r.json();
        const resultado = data.results?.[0];

        const entry = {
          variação,
          query: enderecoVariação,
          status: data.status,
          formatted: resultado?.formatted_address || null,
          location_type: resultado?.geometry?.location_type || null,
          partial_match: resultado?.partial_match || null,
          location: resultado?.geometry?.location || null,
        };

        results.variações_testadas.push(entry);

        // Para no primeiro resultado confiável
        if (
          resultado &&
          !resultado.partial_match &&
          ['ROOFTOP', 'RANGE_INTERPOLATED'].includes(resultado.geometry?.location_type)
        ) {
          results.variação_encontrada = entry;
          break;
        }
      }
    }
  } catch (e) {
    results.variacoes = { error: e.message };
  }
  return res.status(200).json(results);
}