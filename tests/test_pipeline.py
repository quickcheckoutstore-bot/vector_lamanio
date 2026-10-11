import io
import json
import os
import struct
import time
import xml.etree.ElementTree as ET
from pathlib import Path

os.environ['DATA_DIR'] = str(Path(__file__).resolve().parent.parent / '.tmp' / 'test-data')

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageChops, ImageStat
import resvg_py
from text_fixture import text_design
from backend import store
from backend.main import app
from backend.worker import claim, cleanup, process


@pytest.fixture(autouse=True)
def fresh_database():
    store.init()
    with store.connection() as db:
        db.execute('DELETE FROM jobs')
    yield
    with store.connection() as db:
        rows = db.execute('SELECT id FROM jobs').fetchall()
        db.execute("UPDATE jobs SET status='cancelled'")
    cleanup()


def png(size=(160, 100), transparent=False):
    image = Image.new('RGBA', size, (0, 0, 0, 0) if transparent else '#ffffff')
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 20, size[0]-20, size[1]-20), fill='#d05060')
    out = io.BytesIO()
    image.save(out, format='PNG')
    return out.getvalue()


def submit(client, content=None, **params):
    return client.post('/api/jobs', params={'name':'test.png', 'profile':'precise', **params}, content=content or png(), headers={'Content-Type':'image/png'})


def finish(client, job_id):
    row = claim()
    assert row['id'] == job_id
    process(job_id, json.loads(row['options']))
    result = client.get(f'/api/jobs/{job_id}').json()
    assert result['status'] == 'ready', result
    return result


def test_trace_edit_download_and_session_isolation():
    with TestClient(app) as a, TestClient(app) as b:
        a.get('/api/config')
        job = submit(a).json()
        assert b.get(f"/api/jobs/{job['id']}").status_code == 404
        assert b.get('/api/jobs').json() == []
        ready = finish(a, job['id'])
        base = f"/api/jobs/{job['id']}"
        svg = ET.fromstring(a.get(base+'/svg').content)
        paths = list(svg)
        assert len(paths) >= 2
        shape = paths[0].get('id')
        edits = {'revision':0,'deleted':[shape],'fills':{paths[-1].get('id'):'#112233'},'crop':[10,10,100,70]}
        assert a.put(base+'/edits',json=edits).json() == {'revision':1}
        assert a.put(base+'/edits',json=edits).status_code == 409
        export = a.get(base+'/svg?download=true')
        assert 'attachment' in export.headers['content-disposition']
        result = ET.fromstring(export.content)
        assert result.get('viewBox') == '10.0 10.0 100.0 70.0'
        assert len(result) == len(paths)-1
        assert list(result)[-1].get('fill') == '#112233'
        assert len(ET.fromstring(a.get(base+'/svg?original=true').content)) == len(paths)
        assert a.get(base+'/preview').status_code == 200
        assert not (store.DATA / job['id'] / 'source.png').exists()
        assert ready['metadata']['width'] == 160


def test_invalid_upload_limits_and_settings(monkeypatch):
    import backend.main as main
    with TestClient(app) as c:
        assert c.post('/api/jobs',content=b'not png').status_code == 415
        assert submit(c, b'bad').status_code == 415
        assert submit(c,colors=20).status_code == 422
        oversized = b'\x89PNG\r\n\x1a\n'+struct.pack('>I',13)+b'IHDR'+struct.pack('>II',100000,100000)
        assert submit(c,oversized).status_code == 413
        monkeypatch.setattr(main,'MAX_UPLOAD',10)
        assert submit(c).status_code == 413
        assert c.get('/api/jobs').json() == []


def test_queue_backpressure_cancel_and_worker_recovery(monkeypatch):
    import backend.main as main
    monkeypatch.setattr(main,'MAX_PENDING',1)
    with TestClient(app) as c:
        first = submit(c).json()
        assert submit(c).status_code == 429
        assert c.delete(f"/api/jobs/{first['id']}").status_code == 200
        assert claim() is None
        cleanup()
        second = submit(c).json()
        claim()
        with store.connection() as db:
            db.execute('UPDATE jobs SET updated=? WHERE id=?',(time.time()-200,second['id']))
        claim()
        assert c.get(f"/api/jobs/{second['id']}").json()['status'] == 'failed'


def test_transparency_and_large_image_downsampling():
    with TestClient(app) as c:
        job = submit(c,png((3200,1800),transparent=True),quality='fast').json()
        ready = finish(c,job['id'])
        m = ready['metadata']
        assert m['width'] == 3200 and m['trace_width'] == 1024
        assert m['paths'] >= 1
        raster = Image.open(io.BytesIO(resvg_py.svg_to_bytes(svg_string=c.get(f"/api/jobs/{job['id']}/svg").text))).convert('RGBA')
        assert raster.getpixel((0,0))[3] == 0
        assert raster.getpixel((1600,900))[3] == 255
        svg = ET.fromstring(c.get(f"/api/jobs/{job['id']}/svg").content)
        assert svg.get('width') == '3200'


def test_corrupt_png_and_invalid_edits():
    with TestClient(app) as c:
        job = submit(c,png()[:30]).json()
        row = claim()
        process(job['id'],json.loads(row['options']))
        assert c.get(f"/api/jobs/{job['id']}").json()['status'] == 'failed'
        job = submit(c).json()
        finish(c,job['id'])
        base = f"/api/jobs/{job['id']}/edits"
        assert c.put(base,json={'revision':0,'deleted':['shape-99999999']}).status_code == 422
        assert c.put(base,json={'revision':0,'fills':{'shape-0':'url(https://example.com)'}}).status_code == 422
        assert c.put(base,json={'revision':0,'crop':[0,0,1000,1000]}).status_code == 422
        assert c.put(base,content=b' ' * (2*1024*1024+1),headers={'Content-Type':'application/json'}).status_code == 413
        assert c.put(base,json={'revision':0},headers={'Origin':'https://example.com'}).status_code == 403


def test_palette_groups_and_merge_sources_persist_and_validate():
    with TestClient(app) as c:
        job = submit(c).json()
        finish(c, job['id'])
        base = f"/api/jobs/{job['id']}"
        edits = {'revision': 0, 'fills': {'shape-0': '#123456'},
                 'palette_groups': [['#123456', '#abcdef'], ['#ffffff']],
                 'palette_sources': {'shape-0': '#ffffff'}}
        edits['palette_auto_merged'] = True
        edits['palette_grouping_version'] = 2
        edits['palette_grouping_mode'] = 'tight'
        edits['palette_bubbles'] = [['#123456'], ['#abcdef'], ['#ffffff']]
        assert c.put(base+'/edits', json=edits).status_code == 200
        saved = c.get(base).json()['edits']
        assert saved['palette_groups'] == edits['palette_groups']
        assert saved['palette_sources'] == edits['palette_sources']
        assert saved['palette_auto_merged'] is True
        assert saved['palette_grouping_version'] == 2
        assert saved['palette_grouping_mode'] == 'tight'
        assert saved['palette_bubbles'] == edits['palette_bubbles']
        assert '#123456' in c.get(base+'/svg').text
        for invalid in [
            {'palette_groups': [['#ffffff'], ['#ffffff']]},
            {'palette_groups': [['url(https://example.com)']]},
            {'palette_bubbles': [['#ffffff'], ['#ffffff']]},
            {'palette_bubbles': [['bad']]},
            {'palette_sources': {'shape-99999999': '#ffffff'}},
            {'palette_sources': {'shape-0': 'bad'}},
            {'palette_grouping_mode': 'unknown'},
            {'palette_grouping_version': 4},
        ]:
            assert c.put(base+'/edits', json={'revision': 1, **invalid}).status_code == 422


def test_cancelled_job_cannot_be_overwritten():
    with TestClient(app) as c:
        job = submit(c).json()
        claim()
        c.delete(f"/api/jobs/{job['id']}")
        store.update(job['id'],status='ready',metadata='{}')
        assert c.get(f"/api/jobs/{job['id']}").json()['status'] == 'cancelled'


def test_expired_artifacts_are_removed():
    with TestClient(app) as c:
        job = submit(c).json()
        finish(c,job['id'])
        with store.connection() as db:
            db.execute('UPDATE jobs SET created=? WHERE id=?',(time.time()-90000,job['id']))
        cleanup()
        assert c.get(f"/api/jobs/{job['id']}").status_code == 404
        assert not (store.DATA/job['id']).exists()


@pytest.mark.parametrize('mode', ['spline','pixel'])
def test_native_text_fidelity_and_punctuation(mode):
    data = text_design()
    source = Image.open(io.BytesIO(data)).convert('RGB')
    with TestClient(app) as c:
        job = submit(c,data,quality='native',profile='precise',mode=mode).json()
        ready = finish(c,job['id'])
        m = ready['metadata']
        assert (m['trace_width'],m['trace_height']) == (3200,240)
        assert not m['resized']
        raster = Image.open(io.BytesIO(resvg_py.svg_to_bytes(svg_string=c.get(f"/api/jobs/{job['id']}/svg").text))).convert('RGB')
        roi = (40,30,560,145)
        error = sum(ImageStat.Stat(ImageChops.difference(source.crop(roi),raster.crop(roi))).mean)/3
        # Old cutout defaults scored >10 and dropped whole letters; both modes must retain readable text.
        assert error < 2.0
        assert max(raster.getpixel((50,130))) < 100
        assert max(raster.getpixel((60,130))) < 100


def test_exact_png_preserves_text_and_every_opaque_pixel():
    data = text_design()
    with TestClient(app) as c:
        job = submit(c, data, profile='exact', quality='fast', colors=2, speckle=64).json()
        ready = finish(c, job['id'])
        assert ready['metadata']['pixel_exact']
        assert not ready['metadata']['resized']
        assert not ready['metadata']['complexity_adjusted']
        svg = c.get(f"/api/jobs/{job['id']}/svg").text
        original = Image.open(io.BytesIO(data)).convert('RGBA')
        raster = Image.open(io.BytesIO(resvg_py.svg_to_bytes(svg_string=svg))).convert('RGBA')
        assert raster.size == original.size
        assert raster.tobytes() == original.tobytes()
        assert '<image' not in svg


def test_exact_png_preserves_transparency_and_does_not_reduce_colors(monkeypatch):
    image = Image.new('RGBA', (4, 2))
    image.putdata([(255,0,0,128),(0,255,0,64),(0,0,255,255),(0,0,0,0)] * 2)
    data = io.BytesIO()
    image.save(data,format='PNG')
    with TestClient(app) as c:
        job = submit(c,data.getvalue(),profile='exact').json()
        finish(c,job['id'])
        svg = c.get(f"/api/jobs/{job['id']}/svg").text
        raster = Image.open(io.BytesIO(resvg_py.svg_to_bytes(svg_string=svg))).convert('RGBA')
        assert raster.tobytes() == image.tobytes()
        monkeypatch.setenv('MAX_SVG_PATHS','1')
        job = submit(c,data.getvalue(),profile='exact').json()
        row = claim()
        process(row['id'],json.loads(row['options']))
        result = c.get(f"/api/jobs/{job['id']}").json()
        assert result['status'] == 'failed'
        assert 'No detail was reduced' in result['error']


def test_native_limit_is_explicit_and_does_not_silently_resize(monkeypatch):
    monkeypatch.setenv('MAX_NATIVE_PIXELS','10000')
    with TestClient(app) as c:
        assert submit(c,png((160,100)),quality='native').status_code == 413
        assert c.get('/api/jobs').json() == []
        job = submit(c,png((160,100)),quality='detail').json()
        finish(c,job['id'])


def test_fragment_packing_keeps_text_and_contours(monkeypatch):
    from backend.svg import normalize
    data = text_design()
    with TestClient(app) as c:
        job = submit(c,data).json()
        original = finish(c,job['id'])
        path = store.DATA / job['id'] / 'vector.svg'
        before = Image.open(io.BytesIO(resvg_py.svg_to_bytes(svg_string=path.read_text()))).convert('RGB')
        metadata = normalize(path,3200,240,1500)
        after = Image.open(io.BytesIO(resvg_py.svg_to_bytes(svg_string=path.read_text()))).convert('RGB')
        assert metadata['fragments_grouped']
        assert metadata['original_paths'] == original['metadata']['paths']
        assert metadata['paths'] <= 1500
        # Grouping can change antialiasing at a shared boundary, but retains every contour.
        assert max(ImageStat.Stat(ImageChops.difference(before,after)).mean) < 0.1
        assert max(after.getpixel((50,130))) < 100
        assert max(after.getpixel((60,130))) < 100


def test_complexity_retry_preserves_resolution_and_reports_adjustment(monkeypatch):
    import backend.worker as worker
    from backend.svg import TraceComplexityError
    real_normalize = worker.normalize
    calls = []
    def constrained(*args):
        calls.append(args)
        if len(calls) == 1:
            raise TraceComplexityError('Test editor budget')
        return real_normalize(*args)
    monkeypatch.setattr(worker,'normalize',constrained)
    with TestClient(app) as c:
        job = submit(c,text_design()).json()
        m = finish(c,job['id'])['metadata']
        assert m['trace_attempts'] == 2 and m['complexity_adjusted']
        assert m['effective_colors'] == 7
        assert (m['trace_width'],m['trace_height']) == (3200,240)


def test_complexity_retries_are_bounded(monkeypatch):
    import backend.worker as worker
    from backend.svg import TraceComplexityError
    calls = []
    def constrained(*args):
        calls.append(args)
        raise TraceComplexityError('Test editor budget')
    monkeypatch.setattr(worker,'normalize',constrained)
    with TestClient(app) as c:
        job = submit(c).json()
        row = claim()
        process(row['id'],json.loads(row['options']))
        result = c.get(f"/api/jobs/{job['id']}").json()
        assert result['status'] == 'failed'
        assert len(calls) == 4
        assert 'Automatic color reduction' in result['error']
        assert not (store.DATA / job['id'] / 'source.png').exists()


def test_noisy_image_fits_budget_without_resizing_or_removing_small_marks(monkeypatch):
    import random
    randomizer = random.Random(17)
    image = Image.new('RGB',(100,100))
    image.putdata([tuple(randomizer.randrange(70,240) for _ in range(3)) for _ in range(10000)])
    ImageDraw.Draw(image).rectangle((49,49,51,51),fill='#000000')
    data = io.BytesIO()
    image.save(data,format='PNG')
    monkeypatch.setenv('MAX_SVG_PATHS','1000')
    with TestClient(app) as c:
        job = submit(c,data.getvalue()).json()
        m = finish(c,job['id'])['metadata']
        assert m['complexity_adjusted'] and m['fragments_grouped']
        assert m['paths'] <= 1000
        assert not m['resized']
        raster = Image.open(io.BytesIO(resvg_py.svg_to_bytes(svg_string=c.get(f"/api/jobs/{job['id']}/svg").text))).convert('RGB')
        assert max(raster.getpixel((50,50))) < 40
