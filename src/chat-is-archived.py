"""Read one allowlisted chat's archive flag. No conversation body is read."""
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

chat_id=sys.argv[1] if len(sys.argv)==2 else ''
if not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', chat_id):
    raise SystemExit('Invalid chat ID')
data_dir=Path(os.environ.get('CNCC_DATA_DIR',Path(__file__).parent))
manifest=json.loads((data_dir/'relations.json').read_text(encoding='utf-8-sig'))
known=[node for group in manifest.get('groups',[]) for node in [group['parent'],*group['children']]]
if not any(node.get('id')==chat_id and node.get('kind')=='codex' and node.get('hostId','local')=='local' for node in known):
    raise SystemExit('Chat outside verified relations')
database=Path(os.environ.get('CNCC_CODEX_HOME',Path.home()/'.codex'))/'state_5.sqlite'
with sqlite3.connect(database.resolve().as_uri()+'?mode=ro',uri=True,timeout=2) as connection:
    connection.execute('PRAGMA query_only=ON')
    row=connection.execute('SELECT archived FROM threads WHERE id=?',(chat_id,)).fetchone()
print(json.dumps({'id':chat_id,'archived':bool(row[0]) if row else None}))
