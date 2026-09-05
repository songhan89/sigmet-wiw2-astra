"""Cache the selected ICAO symbols at a pinned WorldWeatherSymbols revision."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import urllib.request
import xml.etree.ElementTree as ET
APP=Path(__file__).resolve().parents[1]
COMMIT='1b907f04da74c6dfd89508bab119e330ffd2f7b0'
BASE=f'https://raw.githubusercontent.com/OGCMetOceanDWG/WorldWeatherSymbols/{COMMIT}/'
NAMES=['Thunderstorms','Hail','SevereSquallLine','TropicalCyclone','SevereTurbulence','SevereAircraftIcing','FreezingPrecipitation','MountainWaves','WidespreadSandstormOrDuststorm','VisibleVolcanicAshCloud','RadioactiveMaterialsInTheAtmosphere']
folder=APP/'public/symbols';folder.mkdir(exist_ok=True)
def download(name):
    filename=f'WeatherSymbol_ICAO_{name}.svg'
    url=BASE+'symbols/ICAO_SigWx/'+filename
    payload=urllib.request.urlopen(url,timeout=30).read()
    root=ET.fromstring(payload)
    if root.tag!='{http://www.w3.org/2000/svg}svg' or any(el.tag.endswith('}script') for el in root.iter()):
        raise ValueError('Unexpected SVG content')
    (folder/filename).write_bytes(payload)
    return filename,{'source':url,'sha256':hashlib.sha256(payload).hexdigest()}
assets=dict(concurrent.futures.ThreadPoolExecutor(max_workers=6).map(download,NAMES))
license=urllib.request.urlopen(BASE+'LICENSE.md',timeout=30).read()
(folder/'LICENSE.md').write_bytes(license)
(folder/'manifest.json').write_text(json.dumps({'repository':'https://github.com/OGCMetOceanDWG/WorldWeatherSymbols','revision':COMMIT,'license':'CC BY 4.0','assets':assets},indent=2)+'\n')
print(f'Cached {len(assets)} ICAO symbol SVGs with source hashes and licence.')
