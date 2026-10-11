import hashlib
import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

DATA = Path(os.getenv('DATA_DIR', 'data')).resolve()
DATA.mkdir(parents=True, exist_ok=True)


@contextmanager
def connection():
    db = sqlite3.connect(DATA / 'jobs.sqlite', timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA busy_timeout=30000')
    try:
        with db:
            yield db
    finally:
        db.close()


def init():
    with connection() as db:
        db.execute('''CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
            status TEXT NOT NULL, stage TEXT NOT NULL, created REAL NOT NULL,
            updated REAL NOT NULL, options TEXT NOT NULL, metadata TEXT,
            error TEXT, edits TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 0
        )''')
        db.execute('CREATE INDEX IF NOT EXISTS queue ON jobs(status, created)')
        db.execute('CREATE INDEX IF NOT EXISTS owners ON jobs(owner, created)')


def owner_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def update(job_id, **values):
    values['updated'] = time.time()
    with connection() as db:
        db.execute(f"UPDATE jobs SET {', '.join(k + '=?' for k in values)} WHERE id=? AND status='processing'", [*values.values(), job_id])


def public(row):
    return {k: row[k] for k in ('id', 'name', 'status', 'stage', 'created', 'error', 'revision')} | {
        'options': json.loads(row['options']),
        'metadata': json.loads(row['metadata']) if row['metadata'] else None,
        'edits': json.loads(row['edits']),
    }
