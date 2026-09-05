const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** The IWXXM WMO URI identifies a phenomenon, not an image resource.
 * Map only recognized WMO registry URIs to pinned, locally cached ICAO assets.
 * Qualifiers remain in the text code; composites are UI choices, not new WMO symbols.
 */
const symbols:Record<string,string[]>={
  OBSC_TS:['Thunderstorms'], EMBD_TS:['Thunderstorms'], FRQ_TS:['Thunderstorms'],
  SQL_TS:['SevereSquallLine'],
  OBSC_TSGR:['Thunderstorms','Hail'],EMBD_TSGR:['Thunderstorms','Hail'],FRQ_TSGR:['Thunderstorms','Hail'],SQL_TSGR:['SevereSquallLine','Hail'],
  TC:['TropicalCyclone'],SEV_TURB:['SevereTurbulence'],SEV_ICE:['SevereAircraftIcing'],
  SEV_ICE_FZRA:['SevereAircraftIcing','FreezingPrecipitation'],SEV_MTW:['MountainWaves'],
  HVY_DS:['WidespreadSandstormOrDuststorm'],HVY_SS:['WidespreadSandstormOrDuststorm'],
  VA:['VisibleVolcanicAshCloud'],RDOACT_CLD:['RadioactiveMaterialsInTheAtmosphere'],
};
export function symbolAssets(uri:string|null|undefined):string[]{
  if(!uri)return [];
  const match=/^https?:\/\/codes\.wmo\.int\/49-2\/SigWxPhenomena\/([A-Z_]+)$/.exec(uri);
  return match ? (symbols[match[1]]??[]).map(name=>`${basePath}/symbols/WeatherSymbol_ICAO_${name}.svg`) : [];
}
