"""End-to-end PNG benchmark against the actual running containers (dev deps required)."""
import argparse
import json
import time
from pathlib import Path

import httpx
from PIL import Image, ImageDraw


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://localhost:8000')
    parser.add_argument('--width', type=int, default=12000)
    parser.add_argument('--height', type=int, default=8000)
    parser.add_argument('--quality', choices=['fast', 'balanced', 'detail'], default='fast')
    args = parser.parse_args()
    path = Path(__file__).resolve().parent.parent / '.tmp' / 'benchmark.png'
    path.parent.mkdir(exist_ok=True)
    image = Image.new('RGB', (args.width,args.height), '#f5efe6')
    draw = ImageDraw.Draw(image)
    draw.ellipse((args.width*.2,args.height*.15,args.width*.8,args.height*.85),fill='#7859db')
    draw.rectangle((args.width*.35,args.height*.35,args.width*.65,args.height*.65),fill='#aacfa7')
    image.save(path)
    image.close()
    started = time.monotonic()
    with httpx.Client(base_url=args.url, timeout=120) as client:
        client.get('/api/config').raise_for_status()
        with path.open('rb') as source:
            response = client.post('/api/jobs', params={'name':'large-image-benchmark.png','quality':args.quality},
                                   content=iter(lambda: source.read(65536), b''),
                                   headers={'Content-Type':'image/png','Content-Length':str(path.stat().st_size)})
        response.raise_for_status()
        job_id = response.json()['id']
        print('Queued',job_id,flush=True)
        for _ in range(660):
            response = client.get(f'/api/jobs/{job_id}')
            response.raise_for_status()
            job = response.json()
            if job['status'] in ('ready','failed','cancelled'):
                break
            time.sleep(1)
        else:
            raise RuntimeError('Benchmark timed out')
        if job['status'] != 'ready':
            raise RuntimeError(job['error'] or job['status'])
        result = {'source_dimensions':[args.width,args.height], 'source_bytes':path.stat().st_size,
                  'quality':args.quality, 'upload_to_ready_seconds':round(time.monotonic()-started,2), **job['metadata']}
        directory = path.parent.parent / 'test-results'
        directory.mkdir(exist_ok=True)
        (directory / 'benchmark.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
        print(json.dumps(result,indent=2),flush=True)


if __name__ == '__main__':
    main()
