"""SQLite storage for compatible JSON-shaped datasets and audit records."""
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from threading import RLock, local


class StateStore:
    def __init__(self, data_dir, state_dir, legacy_state=None):
        self.data_dir = Path(data_dir).resolve()
        self.path = Path(state_dir) / 'jinsha.sqlite3'
        self.legacy_state = Path(legacy_state) if legacy_state else None
        self.lock = RLock()
        self.connections = local()
        self.initialized = False

    def key(self, path):
        return Path(path).resolve().relative_to(self.data_dir).as_posix()

    @contextmanager
    def _connection(self):
        current = getattr(self.connections, 'active', None)
        if current is not None:
            yield current
            return
        con = sqlite3.connect(self.path, timeout=15)
        try:
            with con:
                yield con
        finally:
            con.close()

    @contextmanager
    def transaction(self):
        self.initialize()
        with self._connection() as con:
            con.execute('BEGIN IMMEDIATE')
            self.connections.active = con
            try:
                yield
            finally:
                self.connections.active = None

    def initialize(self):
        with self.lock:
            if self.initialized:
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self._connection() as con:
                con.execute('PRAGMA journal_mode=WAL')
                con.execute('''CREATE TABLE IF NOT EXISTS datasets (
                    path TEXT PRIMARY KEY,
                    payload TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 1
                )''')
                con.execute('''CREATE TABLE IF NOT EXISTS audit_events (
                    id INTEGER PRIMARY KEY,
                    payload TEXT NOT NULL
                )''')
                con.execute('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)')
                con.execute('BEGIN IMMEDIATE')
                if not con.execute("SELECT 1 FROM migrations WHERE name='json-v1'").fetchone():
                    mutable = ('users.json', 'governance.json', 'stations.json', 'climate.json',
                               'tasks.json', 'scenarios.json', 'ml_models.json')
                    if self.legacy_state:
                        self._import(con, self.legacy_state, (
                            self.legacy_state / name for name in mutable
                        ))
                    self._import(con, self.data_dir, (
                        path for path in self.data_dir.rglob('*')
                        if path.suffix in ('.json', '.geojson')
                        and not any(part.startswith('.') or part == 'sql'
                                    for part in path.relative_to(self.data_dir).parts)
                    ))
                    for root in (self.legacy_state, self.data_dir):
                        if root and (root / 'audit.log').is_file():
                            with (root / 'audit.log').open(encoding='utf-8-sig') as fp:
                                for row in fp:
                                    try:
                                        payload = json.dumps(json.loads(row), ensure_ascii=False)
                                    except ValueError:
                                        continue
                                    con.execute('INSERT INTO audit_events(payload) VALUES (?)', (payload,))
                            break
                    con.execute("INSERT INTO migrations(name) VALUES ('json-v1')")
            self.initialized = True

    def _import(self, con, root, paths):
        for path in paths:
            try:
                payload = path.read_text(encoding='utf-8-sig')
                json.loads(payload)
            except (OSError, UnicodeError, ValueError):
                continue
            con.execute('INSERT OR IGNORE INTO datasets(path,payload) VALUES (?,?)', (
                path.relative_to(root).as_posix(), payload,
            ))

    def read(self, path, default=None):
        self.initialize()
        key = self.key(path)
        with self._connection() as con:
            row = con.execute('SELECT payload FROM datasets WHERE path=?', (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def write(self, path, value):
        self.initialize()
        key = self.key(path)
        payload = json.dumps(value, ensure_ascii=False, separators=(',', ':'))
        with self._connection() as con:
            con.execute('''INSERT INTO datasets(path,payload) VALUES (?,?)
                        ON CONFLICT(path) DO UPDATE SET
                        payload=excluded.payload, revision=datasets.revision+1''', (key, payload))

    def fingerprint(self, path):
        self.initialize()
        key = self.key(path)
        with self._connection() as con:
            row = con.execute('SELECT payload FROM datasets WHERE path=?', (key,)).fetchone()
        if not row:
            return None
        from hashlib import sha256
        payload = row[0].encode('utf-8')
        return len(payload), sha256(payload).hexdigest()

    def append_audit(self, value):
        self.initialize()
        with self._connection() as con:
            con.execute('INSERT INTO audit_events(payload) VALUES (?)', (
                json.dumps(value, ensure_ascii=False),
            ))

    def counts(self):
        self.initialize()
        with self._connection() as con:
            datasets = con.execute('SELECT COUNT(*) FROM datasets').fetchone()[0]
            audit_events = con.execute('SELECT COUNT(*) FROM audit_events').fetchone()[0]
        return {'datasets': datasets, 'auditEvents': audit_events}

    def audit_rows(self, limit=40):
        self.initialize()
        with self._connection() as con:
            rows = con.execute('SELECT payload FROM audit_events ORDER BY id DESC LIMIT ?', (limit,)).fetchall()
        return [json.loads(row[0]) for row in rows]
