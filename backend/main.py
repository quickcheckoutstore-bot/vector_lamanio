import json
import os
import re
import secrets
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from . import store
from .svg import render

MAX_UPLOAD = int(os.getenv('MAX_UPLOAD_MB', '256')) * 1024 * 1024
MAX_PENDING = int(os.getenv('MAX_PENDING_JOBS', '8'))


@asynccontextmanager
async def lifespan(app):
    store.init()
    yield


app = FastAPI(title='Vectorio', lifespan=lifespan)


@app.middleware('http')
async def session(request: Request, call_next):
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        origin = request.headers.get('origin')
        if origin and origin != f'{request.url.scheme}://{request.headers.get("host")}':
            return Response('Cross-origin requests are disabled', status_code=403)
    token = request.cookies.get('vectorio_session', '')
    fresh = not re.fullmatch(r'[a-zA-Z0-9_-]{43}', token)
    if fresh:
        token = secrets.token_urlsafe(32)
    request.state.owner = store.owner_hash(token)
    response = await call_next(request)
    if fresh:
        response.set_cookie('vectorio_session', token, httponly=True, samesite='strict',
                            secure=os.getenv('COOKIE_SECURE', 'false').lower() == 'true', max_age=2592000)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'same-origin'
    response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    if request.url.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
    return response


def owned(request, job_id):
    with store.connection() as db:
        row = db.execute('SELECT * FROM jobs WHERE id=? AND owner=?', (job_id, request.state.owner)).fetchone()
    if not row:
        raise HTTPException(404, 'Project not found or expired')
    return row


@app.get('/api/health')
def health():
    with store.connection() as db:
        db.execute('SELECT 1').fetchone()
    return {'status': 'ok'}


@app.get('/api/config')
def config():
    return {'max_upload_mb': MAX_UPLOAD // 1024 // 1024,
            'max_image_pixels': int(os.getenv('MAX_IMAGE_PIXELS', '100000000')),
            'max_trace_dimension': int(os.getenv('MAX_TRACE_DIMENSION', '4096')),
            'max_native_pixels': int(os.getenv('MAX_NATIVE_PIXELS', '16000000'))}


@app.get('/api/jobs')
def jobs(request: Request):
    with store.connection() as db:
        rows = db.execute('SELECT * FROM jobs WHERE owner=? ORDER BY created DESC LIMIT 50', (request.state.owner,)).fetchall()
    return [store.public(row) for row in rows]


@app.post('/api/jobs', status_code=202)
async def upload(request: Request, name: str = 'design.png', quality: Literal['native', 'fast', 'balanced', 'detail'] = 'native',
                 colors: int = 8, speckle: int = 0, mode: Literal['spline', 'polygon', 'pixel'] = 'spline',
                 profile: Literal['exact', 'precise', 'artwork'] = 'exact'):
    if profile == 'exact':
        quality, colors, speckle, mode = 'native', 8, 0, 'pixel'
    if not 1 <= colors <= 8 or not 0 <= speckle <= 64:
        raise HTTPException(422, 'Invalid trace settings')
    if request.headers.get('content-type', '').split(';')[0] != 'image/png':
        raise HTTPException(415, 'Upload a PNG image')
    try:
        declared_size = int(request.headers.get('content-length', '0'))
    except ValueError:
        raise HTTPException(400, 'Invalid content length')
    if declared_size < 0:
        raise HTTPException(400, 'Invalid content length')
    if declared_size > MAX_UPLOAD:
        raise HTTPException(413, 'File exceeds upload limit')
    if shutil.disk_usage(store.DATA).free < MAX_UPLOAD + 256 * 1024 * 1024:
        raise HTTPException(507, 'Server storage is nearly full. Wait for automatic cleanup or free disk space.')
    job_id = str(uuid.uuid4())
    directory = store.DATA / job_id
    now = time.time()
    options = {'quality': quality, 'colors': colors, 'speckle': speckle, 'mode': mode, 'profile': profile, 'source_bytes': 0}
    with store.connection() as db:
        db.execute('BEGIN IMMEDIATE')
        pending = db.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('uploading','queued','processing')").fetchone()[0]
        if pending >= MAX_PENDING:
            raise HTTPException(429, 'The queue is full. Try again when a job finishes.')
        db.execute('INSERT INTO jobs(id,owner,name,status,stage,created,updated,options) VALUES (?,?,?,?,?,?,?,?)',
                   (job_id, request.state.owner, Path(name.replace('\\', '/')).name[:160] or 'design.png', 'uploading', 'Uploading PNG', now, now, json.dumps(options)))
    size = 0
    header = b''
    last_heartbeat = time.monotonic()
    try:
        directory.mkdir()
        with (directory / 'source.png').open('wb') as output:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_UPLOAD:
                    raise HTTPException(413, 'File exceeds upload limit')
                if len(header) < 24:
                    header = (header + chunk)[:24]
                output.write(chunk)
                if time.monotonic() - last_heartbeat > 5:
                    with store.connection() as db:
                        db.execute("UPDATE jobs SET updated=? WHERE id=? AND status='uploading'", (time.time(), job_id))
                    last_heartbeat = time.monotonic()
        if len(header) < 24 or header[:8] != b'\x89PNG\r\n\x1a\n' or header[12:16] != b'IHDR':
            raise HTTPException(415, 'This file is not a valid PNG')
        width, height = int.from_bytes(header[16:20], 'big'), int.from_bytes(header[20:24], 'big')
        if not width or not height or width * height > int(os.getenv('MAX_IMAGE_PIXELS', '100000000')):
            raise HTTPException(413, 'Image dimensions exceed the server pixel limit')
        if quality == 'native' and width * height > int(os.getenv('MAX_NATIVE_PIXELS', '16000000')):
            raise HTTPException(413, 'Image exceeds the native-resolution pixel limit. Choose Detailed to resize, or increase MAX_NATIVE_PIXELS on a server with more memory.')
        options['source_bytes'] = size
        with store.connection() as db:
            changed = db.execute("UPDATE jobs SET status='queued',stage='Waiting for worker',options=?,updated=? WHERE id=? AND status='uploading'", (json.dumps(options),time.time(),job_id)).rowcount
            if not changed:
                raise HTTPException(409, 'Upload expired or was cancelled. Please try again.')
    except BaseException:
        shutil.rmtree(directory, ignore_errors=True)
        with store.connection() as db:
            db.execute('DELETE FROM jobs WHERE id=?', (job_id,))
        raise
    return store.public(owned(request, job_id))


@app.get('/api/jobs/{job_id}')
def job(request: Request, job_id: str):
    return store.public(owned(request, job_id))


@app.get('/api/jobs/{job_id}/svg')
def svg(request: Request, job_id: str, download: bool = False, original: bool = False):
    row = owned(request, job_id)
    if row['status'] != 'ready':
        raise HTTPException(409, 'Vector is not ready')
    content = render(store.DATA / job_id / 'vector.svg', {} if original else json.loads(row['edits']))
    headers = {}
    if download:
        headers['Content-Disposition'] = 'attachment; filename="vectorio-export.svg"'
    return Response(content, media_type='image/svg+xml', headers=headers)


@app.get('/api/jobs/{job_id}/preview')
def preview(request: Request, job_id: str):
    row = owned(request, job_id)
    path = store.DATA / job_id / 'preview.png'
    if row['status'] != 'ready' or not path.exists():
        raise HTTPException(404, 'Preview is not ready')
    return FileResponse(path, media_type='image/png')


class Edits(BaseModel):
    deleted: list[str] = Field(default_factory=list, max_length=20000)
    fills: dict[str, str] = Field(default_factory=dict, max_length=20000)
    crop: list[float] | None = Field(default=None, min_length=4, max_length=4)
    palette_groups: list[list[str]] = Field(default_factory=list, max_length=20000)
    palette_bubbles: list[list[str]] = Field(default_factory=list, max_length=20000)
    palette_sources: dict[str, str] = Field(default_factory=dict, max_length=20000)
    palette_auto_merged: bool = False
    palette_grouping_version: int = Field(default=0, ge=0, le=3)
    palette_grouping_mode: Literal['tight', 'balanced', 'broad'] = 'balanced'
    revision: int = Field(ge=0)


@app.put('/api/jobs/{job_id}/edits')
async def save(request: Request, job_id: str):
    row = owned(request, job_id)
    if row['status'] != 'ready':
        raise HTTPException(409, 'Vector is not ready')
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > 2 * 1024 * 1024:
            raise HTTPException(413, 'Editor state exceeds the 2 MB limit')
        body.extend(chunk)
    try:
        edits = Edits.model_validate_json(bytes(body))
    except ValidationError:
        raise HTTPException(422, 'Invalid editor state')
    metadata = json.loads(row['metadata'])
    valid_id = lambda key: bool(re.fullmatch(r'shape-\d{1,10}', key)) and int(key[6:]) < metadata['paths']
    if any(not valid_id(key) for key in [*edits.deleted, *edits.fills, *edits.palette_sources]):
        raise HTTPException(422, 'Unknown shape')
    palette_colors = [color for group in edits.palette_groups for color in group]
    if len(palette_colors) > 20000 or len(set(palette_colors)) != len(palette_colors):
        raise HTTPException(422, 'Palette groups must contain unique colors within the editor limit')
    bubble_colors = [color for bubble in edits.palette_bubbles for color in bubble]
    if len(bubble_colors) > 20000 or len(set(bubble_colors)) != len(bubble_colors):
        raise HTTPException(422, 'Palette bubbles must contain unique colors within the editor limit')
    if any(not re.fullmatch(r'#[0-9a-fA-F]{6}', color) for color in [*edits.fills.values(), *edits.palette_sources.values(), *palette_colors, *bubble_colors]):
        raise HTTPException(422, 'Use a six-digit hex color')
    if edits.crop:
        x, y, w, h = edits.crop
        if not (x >= 0 and y >= 0 and w > 0 and h > 0 and x + w <= metadata['trace_width'] and y + h <= metadata['trace_height']):
            raise HTTPException(422, 'Crop must be inside the image')
    data = edits.model_dump(exclude={'revision'})
    with store.connection() as db:
        changed = db.execute('UPDATE jobs SET edits=?, revision=revision+1 WHERE id=? AND revision=?',
                             (json.dumps(data), job_id, edits.revision)).rowcount
    if not changed:
        raise HTTPException(409, 'This project changed in another tab. Reload before saving.')
    return {'revision': edits.revision + 1}


@app.delete('/api/jobs/{job_id}')
def delete(request: Request, job_id: str):
    owned(request, job_id)
    with store.connection() as db:
        db.execute("UPDATE jobs SET status='cancelled', stage='Cancelled', updated=? WHERE id=?", (time.time(), job_id))
    return {'status': 'cancelled'}


app.mount('/', StaticFiles(directory=Path(__file__).resolve().parent.parent / 'frontend', html=True), name='frontend')
