export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { address } = req.query;

  if (!address) {
    return res.status(400).json({ error: 'Endereço obrigatório' });
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK') {
      return res.status(404).json({ error: 'Endereço não encontrado' });
    }

    const { lat, lng } = data.results[0].geometry.location;

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
      latitude_decimal: lat,
      longitude_decimal: lng,
      latitude_cpfl: `${latDir} ${latGMS.degrees} ${latGMS.minutes} ${latGMS.seconds}`,
      longitude_cpfl: `${lngDir} ${lngGMS.degrees} ${lngGMS.minutes} ${lngGMS.seconds}`,
      latitude_sirgas: `${latGMS.degrees}º ${latGMS.minutes}'' ${parseFloat(latGMS.seconds).toFixed(1)}' ${latDir}`,
      longitude_sirgas: `${lngGMS.degrees}º ${lngGMS.minutes}'' ${parseFloat(lngGMS.seconds).toFixed(1)}' ${lngDirW}`,
      endereco_confirmado: data.results[0].formatted_address
    });

  } catch (error) {
    return res.status(500).json({ error: 'Erro interno', details: error.message });
  }
}