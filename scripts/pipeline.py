"""Read-only IWXXM ingestion; legacy XML/PNG exports and replay data.

Run from any directory: .venv/bin/python scripts/pipeline.py
Source files are never opened for writing. Generated outputs are manifest-owned.
"""
from __future__ import annotations
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parent
SOURCE = ROOT / 'data/aviation_sigmet/2026/05'
CACHE = APP / '.cache'
os.environ.setdefault('MPLCONFIGDIR', str(CACHE / 'matplotlib'))
os.environ.setdefault('XDG_CACHE_HOME', str(CACHE))
NS = {'i': 'http://icao.int/iwxxm/2023-1', 'g': 'http://www.opengis.net/gml/3.2',
      'a': 'http://www.aixm.aero/schema/5.1.1', 'x': 'http://www.w3.org/1999/xlink'}
HAZARDS = {
    'OBSC_TS': ('OBSC TS', 'Obscured thunderstorms'),
    'EMBD_TS': ('EMBD TS', 'Embedded thunderstorms'),
    'FRQ_TS': ('FRQ TS', 'Frequent thunderstorms'),
    'SQL_TS': ('SQL TS', 'Squall-line thunderstorms'),
    'OBSC_TSGR': ('OBSC TSGR', 'Obscured thunderstorms with hail'),
    'EMBD_TSGR': ('EMBD TSGR', 'Embedded thunderstorms with hail'),
    'FRQ_TSGR': ('FRQ TSGR', 'Frequent thunderstorms with hail'),
    'SQL_TSGR': ('SQL TSGR', 'Squall-line thunderstorms with hail'),
    'TC': ('TC', 'Tropical cyclone'), 'SEV_TURB': ('SEV TURB', 'Severe turbulence'),
    'SEV_ICE': ('SEV ICE', 'Severe aircraft icing'),
    'SEV_ICE_FZRA': ('SEV ICE (FZRA)', 'Severe icing from freezing rain'),
    'SEV_MTW': ('SEV MTW', 'Severe mountain waves'),
    'HVY_DS': ('HVY DS', 'Heavy duststorm'), 'HVY_SS': ('HVY SS', 'Heavy sandstorm'),
    'VA': ('VA', 'Volcanic ash'), 'RDOACT_CLD': ('RDOACT CLD', 'Radioactive cloud'),
}
COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
           'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
INTENSITY = {'INTENSIFY': '↑ Intensifying', 'NO_CHANGE': '= No change', 'WEAKEN': '↓ Weakening'}
SOURCE_NAME = re.compile(r'[LW][A-Z]{3}\d{2}[A-Z]{4}\d{18}$')
NE_URL = 'https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_coastline.zip'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def utc(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def text(node, path, default=None):
    value = node.findtext(path, namespaces=NS)
    return value.strip() if value and value.strip() else default


def required(node, path):
    value = text(node, path)
    if value is None:
        raise ValueError(f'Missing required field: {path}')
    return value


def parse_xml(raw):
    start = raw.find('<?xml')
    if start < 0:
        raise ValueError('Missing XML declaration')
    payload = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', raw[start:]).strip()
    if '<!DOCTYPE' in payload.upper() or '<!ENTITY' in payload.upper():
        raise ValueError('DTD/entity declarations are not supported')
    return ET.fromstring(payload, parser=ET.XMLParser(target=ET.TreeBuilder(insert_comments=True)))


def level(node, name):
    el = node.find(f'.//a:{name}Limit', NS)
    if el is None or not el.text or not el.text.strip():
        return None
    return {'value': el.text.strip(), 'unit': el.get('uom'),
            'reference': text(node, f'.//a:{name}LimitReference')}


def level_label(value):
    if not value:
        return 'Not reported'
    return f"FL{value['value']}" if value['unit'] == 'FL' else f"{value['value']} {value['unit'] or ''}".strip()


def motion(node, tac):
    direction = node.find('i:directionOfMotion', NS)
    speed = node.find('i:speedOfMotion', NS)
    bearing = float(direction.text) if direction is not None and direction.text else None
    if bearing is not None and (direction.get('uom') != 'deg' or not 0 <= bearing <= 360):
        raise ValueError('Unsupported motion direction')
    value = float(speed.text) if speed is not None and speed.text else None
    unit = speed.get('uom') if speed is not None else None
    if value is not None and (not math.isfinite(value) or value < 0):
        raise ValueError('Invalid speed')
    stationary = bool(re.search(r'\bSTNR\b', tac)) or value == 0
    compass = COMPASS[int((bearing % 360 + 11.25) // 22.5) % 16] if bearing is not None else None
    display_unit = {'[kn_i]': 'KT', 'km/h': 'KMH', 'm/s': 'm/s'}.get(unit, unit)
    if stationary:
        label = 'STNR · Stationary'
    elif value is not None:
        label = f"{compass or 'Direction not reported'} {value:g} {display_unit or ''}".strip()
    else:
        label = 'Not reported'
    return {'bearing': bearing, 'speed': value, 'unit': unit, 'stationary': stationary,
            'label': label, 'stationarySource': 'embedded TAC' if stationary and value is None else 'IWXXM'}


def parse_report(path):
    from shapely.geometry import Polygon, shape
    raw = path.read_text()
    root = parse_xml(raw)
    reports = [el for el in root.iter() if isinstance(el.tag, str) and el.tag in
               [f"{{{NS['i']}}}{name}" for name in ['SIGMET', 'TropicalCycloneSIGMET', 'VolcanicAshSIGMET']]]
    if len(reports) != 1:
        raise ValueError(f'Expected one IWXXM 2023-1 report; found {len(reports)}')
    r = reports[0]
    comments = [el.text.strip() for el in r.iter() if el.tag is ET.Comment and el.text and re.search(r'\bSIGMET\b', el.text)]
    if len(comments) != 1:
        raise ValueError('Expected exactly one embedded TAC SIGMET comment')
    tac = comments[0]
    bulletin = re.search(r'([A-Z]{4}\d{2})\s+([A-Z]{4})\s+(\d{6})', raw[:raw.index('<?xml')])
    if not bulletin:
        raise ValueError('Missing bulletin heading')
    issued = required(r, 'i:issueTime//g:timePosition')
    start, end = [required(r, f'i:validPeriod//g:{side}Position') for side in ['begin', 'end']]
    raw_end = end
    quality = []
    if utc(start) >= utc(end):
        # Narrow, evidence-backed correction: an end DDHHmm before month-end
        # is encoded in the starting month although embedded TAC rolls forward.
        match = re.search(r'\bVALID (\d{6})/(\d{6})', tac)
        a, b = utc(start), utc(end)
        if not (match and match[1] == a.strftime('%d%H%M') and match[2] == b.strftime('%d%H%M')
                and (a.year,a.month) == (b.year,b.month) and b.day < a.day):
            raise ValueError('Invalid validity period without corroborating TAC rollover')
        month = a.month % 12 + 1
        corrected = b.replace(year=a.year + (a.month == 12), month=month)
        if not 0 < (corrected-a).total_seconds() <= 6*3600:
            raise ValueError('Unsupported rollover duration')
        end = corrected.strftime('%Y-%m-%dT%H:%M:%SZ')
        quality.append(f'Validity end corrected in derived data from {raw_end} to {end}; embedded TAC confirms month rollover. Source unchanged.')
    seq = required(r, 'i:sequenceNumber')
    cnl = r.get('isCancelReport') == 'true'
    phenomenon = r.find('i:phenomenon', NS)
    key = phenomenon.get(f"{{{NS['x']}}}href", '').rsplit('/', 1)[-1] if phenomenon is not None else None
    if not cnl and key not in HAZARDS:
        raise ValueError(f'Unsupported hazard code {key!r}')
    conditions = []
    for node in r.findall('.//i:analysis//i:SIGMETEvolvingCondition', NS):
        polygons = []
        for surface in node.findall('.//a:Surface', NS):
            crs = surface.get('srsName', '')
            axis = surface.get('axisLabels', '')
            if not crs.endswith('/4326') or surface.get('srsDimension', '2') != '2' or axis not in ['', 'Lat Long']:
                raise ValueError(f'Unsupported CRS/axis: {crs} / {axis}')
            for patch in surface.findall('.//g:PolygonPatch', NS):
                rings = []
                for role in ['exterior', 'interior']:
                    for ring in patch.findall(f'g:{role}/g:LinearRing/g:posList', NS):
                        nums = [float(v) for v in (ring.text or '').split()]
                        if len(nums) % 2 or len(nums) < 8:
                            raise ValueError('Invalid polygon coordinate count')
                        coords = [[nums[i+1], nums[i]] for i in range(0, len(nums), 2)]
                        if coords[0] != coords[-1] or any(not (-180 <= x <= 180 and -90 <= y <= 90) for x,y in coords):
                            raise ValueError('Invalid polygon coordinates/closure')
                        rings.append(coords)
                if not rings:
                    raise ValueError('Polygon has no exterior ring')
                poly = Polygon(rings[0], rings[1:])
                if not poly.is_valid or poly.is_empty:
                    raise ValueError('Invalid source polygon; not repaired silently')
                polygons.append(rings)
        if not polygons:
            raise ValueError('Unsupported or absent analysis polygon geometry')
        geom = {'type': 'MultiPolygon', 'coordinates': polygons}
        anchor = shape(geom).representative_point()
        upper, lower = level(node, 'upper'), level(node, 'lower')
        vertical = (level_label(upper) if upper and upper == lower else
                    f'{level_label(lower)} – {level_label(upper)}' if upper and lower else
                    f'TOP {level_label(upper)}' if upper else
                    f'BASE {level_label(lower)}' if lower else 'Not reported')
        conditions.append({'geometry': geom, 'anchor': [anchor.x, anchor.y], 'upper': upper, 'lower': lower,
                           'vertical': vertical, 'intensity': node.get('intensityChange'), 'motion': motion(node, tac)})
    if not cnl and not conditions:
        raise ValueError('No supported analysis conditions')
    collection = r.find('.//i:SIGMETEvolvingConditionCollection', NS)
    result = {'id': path.name, 'source': str(path.relative_to(ROOT)), 'sourceHash': digest(path),
              'issueTime': issued, 'validFrom': start, 'validTo': end, 'rawValidTo': raw_end, 'qualityNotes': quality, 'sequence': seq,
              'firCode': required(r, 'i:issuingAirTrafficServicesRegion//a:designator'),
              'fir': required(r, 'i:issuingAirTrafficServicesRegion//a:name'),
              'issuer': required(r, 'i:originatingMeteorologicalWatchOffice//a:designator'),
              'issuingATS': required(r, 'i:issuingAirTrafficServicesUnit//a:designator'),
              'cancellation': cnl, 'hazardKey': key, 'hazardUri': phenomenon.get(f"{{{NS['x']}}}href") if phenomenon is not None else None,
              'hazard': HAZARDS[key][0] if key else 'CNL SIGMET',
              'description': HAZARDS[key][1] if key else 'SIGMET cancellation',
              'tac': tac, 'conditions': conditions,
              'observation': collection.get('timeIndicator') if collection is not None else None,
              'phenomenonTime': text(collection, 'i:phenomenonTime//g:timePosition') if collection is not None else None,
              'bulletinTime': bulletin[3], 'type': {'LS': 'WS', 'LY': 'WC', 'LV': 'WV'}[bulletin[1][:2]],
              'wmoHeading': f"{r.get('translatedBulletinID', bulletin[1] + bulletin[2] + bulletin[3])[:6]} {bulletin[2]} {bulletin[3]}",
              'targetId': None, 'cancelledBy': None, 'cancelEffective': None}
    if cnl:
        result['cancelSequence'] = required(r, 'i:cancelledReportSequenceNumber')
        result['cancelValidFrom'] = required(r, 'i:cancelledReportValidPeriod//g:beginPosition')
        result['cancelValidTo'] = required(r, 'i:cancelledReportValidPeriod//g:endPosition')
        result['cancelEffective'] = max(issued, start)
    return result


def identity(r, target=False):
    return (r['issuer'], r['firCode'], r['cancelSequence'] if target else r['sequence'],
            r['cancelValidFrom'] if target else r['validFrom'], r['cancelValidTo'] if target else r['validTo'])


def link_cancellations(records):
    originals = {}
    for r in records:
        if not r['cancellation']:
            if identity(r) in originals:
                raise ValueError(f'Duplicate report identity: {identity(r)}')
            originals[identity(r)] = r
    for r in records:
        if r['cancellation']:
            target = originals.get(identity(r, True))
            if target is None:
                raise ValueError(f"Unresolved cancellation: {r['id']}")
            if target['issueTime'] > r['issueTime']:
                raise ValueError('Cancellation references an original issued later')
            if target['cancelledBy'] is not None:
                raise ValueError('Multiple cancellations for same original')
            r['targetId'] = target['id']
            target['cancelledBy'] = r['id']
            target['cancelEffective'] = r['cancelEffective']
    return records


def output_names(r):
    seq = re.fullmatch(r'([ABab])(\d+)', r['sequence'])
    if not seq:
        raise ValueError('Legacy filename sequence mapping supports A/B sequences only')
    mapped = int(seq[2]) + (50 if seq[1].upper() == 'B' else 0)
    stamp = f"{utc(r['issueTime']):%Y%m%d}_{r['bulletinTime']}"
    return f'Sigmetdata_{stamp}.xml', f"sigmet_{r['type'].lower()}_{mapped}_{stamp}.png"


def banner_xml(r):
    root = ET.Element('channel')
    ET.SubElement(root, 'title').text = 'Singapore SIGMET'
    ET.SubElement(root, 'source').text = 'Meteorological Service Singapore'
    item = ET.SubElement(root, 'item')
    dt = utc(r['issueTime'])
    values = {'Year': f'{dt:%Y}', 'Month': f'{dt:%m}', 'Day': f'{dt:%d}', 'SIGMETIssue': f'{dt:%H%M}',
              'Type': r['type'], 'SIGMET_NO': r['sequence'], 'IMAGE_NAME': output_names(r)[1],
              'VALID_START': f"{utc(r['validFrom']):%H%M}", 'VALID_END': f"{utc(r['validTo']):%H%M}",
              'CNL': 'Yes' if r['cancellation'] else 'No',
              'SIGMET': r['wmoHeading'] + ' ' + ' '.join(r['tac'].split()).rstrip('= ')}
    for name, value in values.items():
        ET.SubElement(item, name).text = value
    ET.indent(root)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def coastlines():
    import shapefile
    from shapely.geometry import box, shape
    folder = CACHE / 'natural-earth'
    folder.mkdir(parents=True, exist_ok=True)
    archive = folder / 'ne_10m_coastline.zip'
    if not archive.exists():
        req = urllib.request.Request(NE_URL, headers={'User-Agent': 'SIGMET-POC/1.0'})
        payload = urllib.request.urlopen(req, timeout=60).read()
        with zipfile.ZipFile(io.BytesIO(payload)) as z:
            z.testzip()
        archive.write_bytes(payload)
    with zipfile.ZipFile(archive) as z:
        for name in z.namelist():
            if Path(name).name == name and name.startswith('ne_10m_coastline.'):
                target = folder / name
                if not target.exists():
                    target.write_bytes(z.read(name))
    extent = box(96, -4, 120, 14)
    lines = []
    with shapefile.Reader(str(folder / 'ne_10m_coastline.shp')) as reader:
        for record in reader.iterShapes(bbox=[96,-4,120,14]):
            geom = shape(record.__geo_interface__).intersection(extent)
            if geom.is_empty:
                continue
            for line in ([geom] if geom.geom_type == 'LineString' else getattr(geom, 'geoms', [])):
                if line.geom_type == 'LineString':
                    lines.append(list(line.coords))
    return lines, {'url': NE_URL, 'sha256': digest(archive),
                   'version': (folder / 'ne_10m_coastline.VERSION.txt').read_text().strip() if (folder / 'ne_10m_coastline.VERSION.txt').exists() else 'Recorded by archive SHA-256'}


def destination(anchor, bearing, nautical_miles=45):
    lon, lat = map(math.radians, anchor)
    b = math.radians(bearing)
    d = nautical_miles * 1852 / 6371008.8
    y = math.asin(math.sin(lat)*math.cos(d)+math.cos(lat)*math.sin(d)*math.cos(b))
    x = lon + math.atan2(math.sin(b)*math.sin(d)*math.cos(lat), math.cos(d)-math.sin(lat)*math.sin(y))
    return [math.degrees(x), math.degrees(y)]


def png_bytes(r, original, coast):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection
    from matplotlib.path import Path as MPath
    from matplotlib.patches import PathPatch
    from shapely.geometry.polygon import orient
    from shapely.geometry import Polygon
    fig = plt.figure(figsize=(15.03, 15.03), dpi=100, facecolor='none')
    ax = fig.add_axes([.06,.07,.88,.83], facecolor='none')
    ax.set(xlim=(96,120), ylim=(-4,14), aspect='equal')
    ax.add_collection(LineCollection(coast, colors='#607786', linewidths=.65, zorder=1))
    ax.set_xticks(range(96,121,3)); ax.set_yticks(range(-4,15,2))
    ax.tick_params(labelsize=12, colors='#304c60')
    ax.grid(color='#8da5b4', alpha=.3, linewidth=.5)
    for spine in ax.spines.values(): spine.set_color('#8da5b4')
    display = original if r['cancellation'] else r
    color = '#245d8c' if display['hazardKey'] == 'SEV_ICE' else '#c25316'
    for index, c in enumerate(display['conditions']):
        for polygon in c['geometry']['coordinates']:
            poly = orient(Polygon(polygon[0], polygon[1:]), sign=1)
            vertices, codes = [], []
            for ring in [poly.exterior, *poly.interiors]:
                coords = list(ring.coords)
                vertices.extend(coords); codes.extend([MPath.MOVETO]+[MPath.LINETO]*(len(coords)-2)+[MPath.CLOSEPOLY])
            ax.add_patch(PathPatch(MPath(vertices,codes), facecolor=color, alpha=.22, edgecolor=color, linewidth=2, zorder=2))
        x,y = c['anchor']
        # Keep the detail box away from small hazard polygons.
        ax.text(.98,.97-index*.15, f"{display['hazard']} · {display['sequence']}\n{c['vertical']}", fontsize=14, fontweight='bold',
                transform=ax.transAxes, ha='right', va='top', zorder=4,
                bbox={'facecolor':'white','edgecolor':color,'alpha':.94,'pad':7})
        if not c['motion']['stationary'] and c['motion']['bearing'] is not None:
            end = destination([x,y], c['motion']['bearing'])
            ax.annotate('', xy=end, xytext=[x,y], arrowprops={'arrowstyle':'-|>','color':'#00685f','lw':2.5,'mutation_scale':22}, zorder=5)
        ax.text(.98,.895-index*.15,c['motion']['label']+' · '+INTENSITY.get(c['intensity'],'Not reported'),
                transform=ax.transAxes,ha='right',va='top',fontsize=12,zorder=5,
                bbox={'facecolor':'white','edgecolor':'none','alpha':.9,'pad':3})
    fig.text(.06,.945,f"{r['fir']}  /  SIGMET {r['sequence']}", fontsize=24, fontweight='bold',color='#193e52')
    fig.text(.06,.92,f"Issued {utc(r['issueTime']):%d %b %Y %H:%M} UTC   |   Valid {utc(r['validFrom']):%d %H:%M} – {utc(r['validTo']):%d %H:%M} UTC",fontsize=14,color='#304c60')
    if r['cancellation']:
        ax.text(.5,.5,f"CANCELLED\n{original['hazard']} · {original['sequence']}",transform=ax.transAxes,
                ha='center',va='center',fontsize=32,fontweight='bold',color='#8b2330',zorder=10,
                bbox={'facecolor':'white','edgecolor':'#8b2330','alpha':.94,'pad':18})
    fig.text(.06,.045,'Reported geometry · Direction arrows are schematic; speed is labelled · UTC',fontsize=12,color='#304c60')
    fig.text(.06,.025,'Coastline: Natural Earth 1:10m · Source: supplied IWXXM archive · No FIR boundary overlay',fontsize=12,color='#304c60')
    buf = io.BytesIO(); fig.savefig(buf,format='png',dpi=100,transparent=True);plt.close(fig)
    return buf.getvalue()


def atomic_write(path, payload):
    temp = path.with_name(path.name+'.tmp')
    with temp.open('xb') as stream:
        stream.write(payload)
    temp.replace(path)


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--check',action='store_true',help='Parse, link and validate source hashes without writing outputs')
    args.add_argument('--web-only',action='store_true',help='Refresh website JSON only; do not render or write XML/PNG outputs')
    opts = args.parse_args()
    baseline = json.loads((APP/'source-hashes.json').read_text())
    def verify_sources():
        current = {str(p.relative_to(ROOT)):digest(p) for p in sorted(SOURCE.rglob('*')) if p.is_file() and SOURCE_NAME.fullmatch(p.name)}
        if current != baseline:
            raise ValueError('Source file set or hashes differ from immutable baseline')
    verify_sources()
    records, errors = [], []
    for p in sorted(SOURCE.rglob('*')):
        if p.is_file() and p.name.startswith('L') and SOURCE_NAME.fullmatch(p.name):
            try: records.append(parse_report(p))
            except Exception as e: errors.append(f'{p.name}: {e}')
    if errors:
        raise ValueError('\n'.join(errors))
    records.sort(key=lambda r:(r['issueTime'],r['id']))
    link_cancellations(records)
    outpaths = [(ROOT/r['source']).parent / name for r in records for name in output_names(r)]
    if len(set(outpaths)) != len(outpaths):
        raise ValueError('Output filename collision')
    summary = {'sourceFiles':len(baseline),'reports':len(records),
               'hazards':dict(Counter(r['hazard'] for r in records if not r['cancellation'])),
               'cancellations':sum(r['cancellation'] for r in records),'corrections':sum(bool(r['qualityNotes']) for r in records),'sourceHashesVerified':True}
    if opts.check:
        verify_sources();print(json.dumps(summary,indent=2));return
    if opts.web_only:
        dataset = {'schemaVersion':1,'range':{'start':'2026-05-01T00:00:00Z','end':'2026-05-31T23:30:00Z','stepMinutes':30},'summary':summary,'records':records}
        (APP/'public/data/sigmets.json').write_text(json.dumps(dataset,ensure_ascii=False,separators=(',',':'))+'\n')
        verify_sources();print(f'Updated website dataset: {len(records)} reports. XML/PNG outputs untouched.');return
    manifest_path = APP/'reports/output-manifest.json'
    old = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'outputs':{}}
    for p in outpaths:
        if p.is_symlink(): raise ValueError(f'Refusing output symlink {p}')
        if p.exists() and old['outputs'].get(str(p.relative_to(ROOT))) != digest(p):
            raise ValueError(f'Refusing to overwrite unowned or modified file: {p}')
    coast, ne = coastlines()
    index = {r['id']:r for r in records}
    outputs = dict(old['outputs'])
    try:
        for n,r in enumerate(records,1):
            original = index.get(r['targetId'])
            xmlname,pngname = output_names(r)
            for name,content in [(xmlname,banner_xml(r)),(pngname,png_bytes(r,original,coast))]:
                p = (ROOT/r['source']).parent/name
                atomic_write(p,content)
                outputs[str(p.relative_to(ROOT))] = hashlib.sha256(content).hexdigest()
                manifest_path.write_text(json.dumps({'summary':summary,'naturalEarth':ne,'outputs':outputs},indent=2)+'\n')
            # Persist ownership after each report so interrupted runs can resume safely.
            manifest_path.write_text(json.dumps({'summary':summary,'naturalEarth':ne,'outputs':outputs},indent=2)+'\n')
            if n%25 == 0: print(f'Generated {n}/{len(records)} report pairs',flush=True)
        dataset = {'schemaVersion':1,'range':{'start':'2026-05-01T00:00:00Z','end':'2026-05-31T23:30:00Z','stepMinutes':30},
                   'summary':summary,'records':records}
        (APP/'public/data/sigmets.json').write_text(json.dumps(dataset,ensure_ascii=False,separators=(',',':'))+'\n')
    finally:
        verify_sources()
    print(json.dumps(summary,indent=2))
    print(f'Generated {len(outpaths)} outputs; all {len(baseline)} source hashes unchanged.')


if __name__ == '__main__':
    try: main()
    except Exception as e:
        print(f'ERROR: {e}',file=sys.stderr);sys.exit(1)
