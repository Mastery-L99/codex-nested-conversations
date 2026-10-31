"""Open one known local chat through the existing Windows Codex protocol."""
import json
import os
from pathlib import Path
import re
import sys

chat_id = sys.argv[1] if len(sys.argv) == 2 else ""
if not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", chat_id):
    raise SystemExit("Invalid chat ID")
data_dir = Path(os.environ.get('CNCC_DATA_DIR', Path(__file__).parent))
data = json.loads((data_dir / 'relations.json').read_text(encoding='utf-8-sig'))
known = data['catalog'] if isinstance(data.get('catalog'),list) else [entry for group in data.get("groups", []) for entry in [group["parent"], *group["children"]]]
if not any(isinstance(row,dict) and row.get("id") == chat_id and row.get("kind") == "codex" and row.get("hostId", "local") == "local" for row in known):
    raise SystemExit("Chat not present in verified local relations")
os.startfile("codex://threads/" + chat_id)
print(json.dumps({"requestedChatId": chat_id}))
