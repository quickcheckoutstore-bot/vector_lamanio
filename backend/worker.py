import json
import logging
import multiprocessing as mp
import os
import shutil
import time
import warnings

from . import store
from .svg import normalize, TraceComplexityError

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')


def process(job_id, options):
    started = time.monotonic()
    from PIL import Image
    import vtracer
    import pyvips
    directory = store.DATA / job_id
    try:
        Image.MAX_IMAGE_PIXELS = int(os.getenv('MAX_IMAGE_PIXELS', '100000000'))
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        store.update(job_id, stage='Decoding PNG')
        with Image.open(directory / 'source.png') as check:
            if check.format != 'PNG':
                raise ValueError('The upload is not a PNG image.')
            width, height = check.size
            if width * height > Image.MAX_IMAGE_PIXELS:
                raise ValueError('Image exceeds the configured pixel limit.')
            if getattr(check, 'n_frames', 1) != 1:
                raise ValueError('Animated PNG is not supported. Export a single frame first.')
            check.verify()
        native = options['quality'] == 'native'
        if native and width * height > int(os.getenv('MAX_NATIVE_PIXELS', '16000000')):
            raise ValueError('Image exceeds the native-resolution pixel limit. Choose Detailed or increase MAX_NATIVE_PIXELS.')
        limit = max(width, height) if native else min({'fast': 1024, 'balanced': 2048, 'detail': 4096}[options['quality']], int(os.getenv('MAX_TRACE_DIMENSION', '4096')))
        # thumbnail() requests sequential decoding where possible, reducing full-size PNG memory.
        # Each job has a fresh process; disable the operation cache and limit native threads.
        pyvips.cache_set_max(0)
        if native:
            # No resampling or filtering of the source's letter edges.
            thumb = pyvips.Image.new_from_file(str(directory / 'source.png'), access='sequential', fail_on='error')
        else:
            thumb = pyvips.Image.thumbnail(str(directory / 'source.png'), limit, height=limit,
                                          size='down', no_rotate=True, fail_on='error')
        thumb.pngsave(str(directory / 'trace.png'), compression=3, strip=True)
        del thumb
        with Image.open(directory / 'trace.png') as reduced:
            image = reduced.convert('RGBA')
        with image:
            image.save(directory / 'trace.png')
            preview = image.copy()
            preview.thumbnail((1280, 1280))
            preview.save(directory / 'preview.png')
        store.update(job_id, stage='Tracing color regions')
        precise = options.get('profile', 'artwork') == 'precise'
        exact = options.get('profile') == 'exact'
        # Retry excessive color fragmentation before suggesting destructive resizing or filtering.
        # Keep resolution, curve settings and speckle filtering exactly as requested.
        attempts = [(options['colors'], 1 if precise else 16, None)]
        attempts += [(max(1, options['colors'] - step), difference, palette)
                     for step, difference, palette in ((1, 4, 256), (2, 8, 128), (3, 16, 64))]
        attempts = list(dict.fromkeys(attempts))
        if exact:
            attempts = [(8, 0, None)]
        for attempt, (colors, difference, palette) in enumerate(attempts):
            if attempt:
                store.update(job_id, stage=f'Reducing color fragmentation (retry {attempt}/{len(attempts)-1})')
            trace_config = vtracer.Config(
                clustering='color-cluster', hierarchical='cutout', mode=options['mode'],
                filter_speckle=options['speckle'], color_precision=colors,
                layer_difference=difference, corner_threshold=30 if precise else 60,
                length_threshold=3.5 if precise else 4.0, max_iterations=15 if precise else 10,
                splice_threshold=30 if precise else 45, path_precision=5 if precise else 3,
                simplify=0.0 if precise else None, optimize=0, max_colors=palette)
            if exact:
                from .exact import convert
                with Image.open(directory / 'trace.png') as source:
                    convert(source.convert('RGBA'), directory / 'vector.svg',
                            int(os.getenv('MAX_SVG_PATHS', '20000')),
                            int(os.getenv('MAX_SVG_MB', '24')) * 1024 * 1024)
            else:
                trace_config.convert_file(str(directory / 'trace.png'), str(directory / 'vector.svg'))
            try:
                metadata = normalize(directory / 'vector.svg', width, height, int(os.getenv('MAX_SVG_PATHS', '20000')))
                if (directory / 'vector.svg').stat().st_size > int(os.getenv('MAX_SVG_MB', '24')) * 1024 * 1024:
                    raise TraceComplexityError('The SVG exceeds the editor size limit. Try the Illustrations profile or reduce color precision.')
                break
            except TraceComplexityError as error:
                if exact:
                    raise TraceComplexityError(f'Exact PNG could not fit the editor limits. No detail was reduced. {error}') from error
                if attempt == len(attempts) - 1:
                    raise TraceComplexityError(f'{error} Automatic color reduction also exceeded the limit.') from error
        store.update(job_id, stage='Preparing editor')
        metadata['complexity_adjusted'] = attempt > 0
        metadata['pixel_exact'] = exact
        metadata['trace_attempts'] = attempt + 1
        metadata['effective_colors'] = colors
        metadata['effective_layer_difference'] = difference
        metadata['effective_palette_colors'] = palette
        metadata['svg_bytes'] = (directory / 'vector.svg').stat().st_size
        metadata['resized'] = metadata['trace_width'] != width or metadata['trace_height'] != height
        metadata['profile'] = options.get('profile', 'artwork')
        metadata['processing_seconds'] = round(time.monotonic() - started, 2)
        try:
            import resource
            # The deployment image is Linux, where ru_maxrss is reported in KiB.
            metadata['peak_rss_mb'] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
        except ImportError:
            metadata['peak_rss_mb'] = None
        store.update(job_id, status='ready', stage='Ready to edit', metadata=json.dumps(metadata))
    except Exception as error:
        logging.exception('Job %s failed', job_id)
        store.update(job_id, status='failed', stage='Processing failed', error=str(error)[:400])
    finally:
        for name in ('source.png', 'trace.png'):
            (directory / name).unlink(missing_ok=True)


def claim():
    with store.connection() as db:
        db.execute('BEGIN IMMEDIATE')
        db.execute("UPDATE jobs SET status='failed', stage='Upload interrupted', error='Upload timed out. Please try again.', updated=? WHERE status='uploading' AND updated<?", (time.time(), time.time() - 300))
        # A killed worker loses its heartbeat. Do not retry an image which may OOM again.
        db.execute("UPDATE jobs SET status='failed', stage='Worker interrupted', error='Worker stopped unexpectedly. Try a lower quality setting.', updated=? WHERE status='processing' AND updated<?", (time.time(), time.time() - 90))
        row = db.execute("SELECT id, options FROM jobs WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
        if row:
            db.execute("UPDATE jobs SET status='processing', stage='Starting worker', updated=? WHERE id=?", (time.time(), row['id']))
    return row


def cleanup():
    cutoff = time.time() - float(os.getenv('RETENTION_HOURS', '24')) * 3600
    with store.connection() as db:
        db.execute('BEGIN IMMEDIATE')
        rows = db.execute("SELECT id FROM jobs WHERE (status IN ('ready','failed') AND created<?) OR status='cancelled'", (cutoff,)).fetchall()
        for row in rows:
            shutil.rmtree(store.DATA / row['id'], ignore_errors=True)
            db.execute('DELETE FROM jobs WHERE id=?', (row['id'],))
    # Incomplete uploads leave no row after an API crash. Reclaim them after an hour.
    with store.connection() as db:
        known = {row[0] for row in db.execute('SELECT id FROM jobs')}
    for directory in store.DATA.iterdir():
        if directory.is_dir() and directory.name not in known and directory.stat().st_mtime < time.time() - 3600:
            shutil.rmtree(directory, ignore_errors=True)


def main():
    store.init()
    context = mp.get_context('spawn')
    last_cleanup = 0
    while True:
        row = claim()
        if row:
            child = context.Process(target=process, args=(row['id'], json.loads(row['options'])))
            child.start()
            started = time.monotonic()
            while child.is_alive():
                child.join(timeout=2)
                with store.connection() as db:
                    current = db.execute('SELECT status FROM jobs WHERE id=?', (row['id'],)).fetchone()
                if not current or current['status'] == 'cancelled':
                    child.terminate()
                    child.join()
                    break
                if time.monotonic() - started > int(os.getenv('JOB_TIMEOUT_SECONDS', '600')):
                    child.terminate()
                    child.join()
                    store.update(row['id'], status='failed', stage='Time limit reached', error='Processing exceeded the time limit. Try Fast quality or fewer colors.')
                    break
                if current['status'] == 'processing':
                    store.update(row['id'])
            with store.connection() as db:
                current = db.execute('SELECT status FROM jobs WHERE id=?', (row['id'],)).fetchone()
            if current and current['status'] == 'processing':
                store.update(row['id'], status='failed', stage='Worker stopped', error='Processing ran out of resources. Try Fast quality or a smaller image.')
            for name in ('source.png', 'trace.png'):
                (store.DATA / row['id'] / name).unlink(missing_ok=True)
        if time.monotonic() - last_cleanup > 60:
            cleanup()
            last_cleanup = time.monotonic()
        if not row:
            time.sleep(1)


if __name__ == '__main__':
    main()
