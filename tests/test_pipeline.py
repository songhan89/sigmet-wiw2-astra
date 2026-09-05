import copy
import json
from pathlib import Path
import sys
import unittest
import xml.etree.ElementTree as ET
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import pipeline as p

class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.records=json.loads((p.APP/'public/data/sigmets.json').read_text())['records']

    def test_all_outputs_schema_dimensions_and_ownership(self):
        from PIL import Image
        manifest=json.loads((p.APP/'reports/output-manifest.json').read_text())
        self.assertEqual(len(manifest['outputs']),386)
        expected={'Year','Month','Day','SIGMETIssue','Type','SIGMET_NO','IMAGE_NAME','VALID_START','VALID_END','CNL','SIGMET'}
        for r in self.records:
            xml,png=p.output_names(r);folder=(p.ROOT/r['source']).parent
            root=ET.parse(folder/xml).getroot();self.assertEqual(root.tag,'channel')
            self.assertEqual({el.tag for el in root.find('item')},expected)
            self.assertEqual(root.findtext('item/IMAGE_NAME'),png)
            self.assertEqual(root.findtext('item/SIGMETIssue'),p.utc(r['issueTime']).strftime('%H%M'))
            with Image.open(folder/png) as image:
                self.assertEqual(image.size,(1503,1503));self.assertEqual(image.mode,'RGBA')
                self.assertEqual(image.getpixel((0,0))[3],0)
        for path,digest in manifest['outputs'].items():self.assertEqual(p.digest(p.ROOT/path),digest)

    def test_original_source_hashes(self):
        for path,digest in json.loads((p.APP/'source-hashes.json').read_text()).items():
            self.assertEqual(p.digest(p.ROOT/path),digest)

    def test_all_hazards_and_legacy_names(self):
        self.assertEqual(len(p.HAZARDS),17)
        self.assertEqual(p.HAZARDS['SEV_ICE_FZRA'][0],'SEV ICE (FZRA)')
        self.assertEqual(p.output_names(self.records[0]),('Sigmetdata_20260501_010645.xml','sigmet_ws_51_20260501_010645.png'))
        self.assertEqual(len({p.output_names(r)[0] for r in self.records}),193)

    def test_transport_and_missing_tac(self):
        path=p.ROOT/self.records[0]['source'];raw=path.read_text()
        with self.assertRaises(ET.ParseError):ET.fromstring(raw[raw.index('<?xml'):])
        self.assertIsNotNone(p.parse_xml(raw))
        with self.assertRaises(ValueError):p.parse_xml('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x/>')

    def test_fir_coordinates_icing_and_motion(self):
        r=next(r for r in self.records if r['hazardKey']=='SEV_ICE')
        self.assertEqual(r['firCode'],'WIIF');self.assertEqual(r['issuer'],'WSSS');self.assertEqual(r['issuingATS'],'WSJC')
        c=r['conditions'][0];self.assertEqual(c['vertical'],'FL190');self.assertEqual(c['motion']['label'],'WNW 15 KT')
        self.assertEqual(c['geometry']['coordinates'][0][0][0],[104.25,1.28])
        stationary=next(c for r in self.records for c in r['conditions'] if c['motion']['stationary'])
        self.assertEqual(stationary['motion']['label'],'STNR · Stationary')
        self.assertEqual(stationary['motion']['stationarySource'],'embedded TAC')
        for b,name in zip(range(0,360,45),['N','NE','E','SE','S','SW','W','NW']):
            node=ET.fromstring(f'<x xmlns:i="{p.NS["i"]}"><i:directionOfMotion uom="deg">{b}</i:directionOfMotion><i:speedOfMotion uom="km/h">20</i:speedOfMotion></x>')
            self.assertEqual(p.motion(node,'')['label'],f'{name} 20 KMH')

    def test_cancellation_identity_not_sequence_alone(self):
        records=copy.deepcopy(self.records)
        for r in records:r['cancelledBy']=None
        p.link_cancellations(records)
        self.assertEqual(sum(bool(r['targetId']) for r in records),16)
        c=next(r for r in records if r['cancellation']); c['cancelSequence']='A99'
        for r in records:r['cancelledBy']=None
        with self.assertRaisesRegex(ValueError,'Unresolved cancellation'):p.link_cancellations(records)

    def test_rollover_and_raw_provenance(self):
        r=p.parse_report(p.ROOT/'data/aviation_sigmet/2026/05/31/LSSR20WSSS312318260531231831')
        self.assertEqual(r['validTo'],'2026-06-01T02:45:00Z');self.assertEqual(r['rawValidTo'],'2026-05-01T02:45:00Z')
        self.assertEqual(len(r['qualityNotes']),1)

if __name__=='__main__':unittest.main()
