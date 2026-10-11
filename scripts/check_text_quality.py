"""Rasterize real vector output and measure errors within a text-heavy region."""
import io
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tests'))
os.environ['DATA_DIR'] = str(ROOT / '.tmp' / 'quality-data')
os.environ['VIPS_CONCURRENCY'] = '1'

from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageChops, ImageStat
import resvg_py
from backend.main import app
from backend.worker import claim, process
from text_fixture import text_design


def main():
    data = text_design()
    source = Image.open(io.BytesIO(data)).convert('RGB')
    roi = (40,30,560,145)
    results = []
    legacy_svg = (ROOT / 'tests' / 'fixtures' / 'legacy-text.svg').read_text(encoding='utf-8')
    legacy = Image.open(io.BytesIO(resvg_py.svg_to_bytes(svg_string=legacy_svg))).convert('RGB')
    legacy_error = sum(ImageStat.Stat(ImageChops.difference(source.crop(roi),legacy.crop(roi))).mean)/3
    results.append({'preset':'Previous engine / defaults','text_region_mae':round(legacy_error,3)})
    previews = [('Original PNG', source.crop(roi)),('Previous engine / defaults',legacy.crop(roi))]
    output = ROOT / 'test-results'
    output.mkdir(exist_ok=True)
    (output / 'text-design.png').write_bytes(data)
    presets = [
        ('Native / Logos & text', dict(quality='native',profile='precise',colors=8,speckle=0,mode='spline')),
        ('Native / Exact contours', dict(quality='native',profile='precise',colors=8,speckle=0,mode='pixel')),
    ]
    with TestClient(app) as client:
        for label, settings in presets:
            job = client.post('/api/jobs',params={'name':'text-design.png',**settings},content=data,headers={'Content-Type':'image/png'})
            job.raise_for_status()
            row = claim()
            process(row['id'],json.loads(row['options']))
            ready = client.get(f"/api/jobs/{row['id']}").json()
            assert ready['status'] == 'ready', ready
            svg = client.get(f"/api/jobs/{row['id']}/svg").text
            raster = Image.open(io.BytesIO(resvg_py.svg_to_bytes(svg_string=svg))).convert('RGB')
            error = sum(ImageStat.Stat(ImageChops.difference(source.crop(roi),raster.crop(roi))).mean)/3
            results.append({'preset':label,'text_region_mae':round(error,3),'metadata':ready['metadata']})
            previews.append((label,raster.crop(roi)))
    comparison = Image.new('RGB',(1040, len(previews)*270),'#f5f5f5')
    draw = ImageDraw.Draw(comparison)
    for i,(label,image) in enumerate(previews):
        draw.text((15,i*270+10),label,fill='#202020')
        comparison.paste(image.resize((1040,230),Image.Resampling.NEAREST),(0,i*270+35))
    comparison.save(output / 'text-quality.png')
    (output / 'text-quality.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
    print(json.dumps([{k:v for k,v in row.items() if k != 'metadata'} | {'paths':row.get('metadata',{}).get('paths')} for row in results],indent=2))


if __name__ == '__main__':
    main()
