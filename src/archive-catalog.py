"""Read local chat metadata for the independent archive module. Never write an official database."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import uuid

sys.dont_write_bytecode = True

USER_THREAD_SOURCES = frozenset(("user", "agent_created_thread", "agent_forked_thread", "voice_chat", "realtime_voice"))


def connect_readonly(path):
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=3)
    connection.execute("PRAGMA query_only=ON")
    connection.row_factory = sqlite3.Row
    return connection


def eligible(row):
    try:
        valid_id = str(uuid.UUID(row["id"])) == row["id"].lower()
    except (ValueError, TypeError, AttributeError):
        return False
    if not valid_id or row["archived"] != 0 or row["agent_path"] or row["thread_source"] not in USER_THREAD_SOURCES:
        return False
    if row["source"] == "exec":
        return False
    try:
        source = json.loads(row["source"] or "")
    except (ValueError, TypeError):
        source = None
    return not (isinstance(source, dict) and "subagent" in source)


def read_catalog(codex_home, include_relations=True):
    # Flat metadata is deliberately independent of the optional nesting reader.
    # A missing or broken tree adapter must not remove selected-only archive.
    with connect_readonly(codex_home / "state_5.sqlite") as state:
        rows = state.execute("SELECT id,name,archived,thread_source,source,agent_path,created_at_ms,created_at,updated_at_ms FROM threads ORDER BY updated_at_ms DESC,id").fetchall()
        rows = [row for row in rows if eligible(row)]
        roots = [row["id"] for row in rows]
        catalog = []
        for row in rows:
            catalog.append({"id": row["id"], "title": row["name"] or row["id"], "kind": "codex", "hostId": "local",
                            "threadSource": row["thread_source"], "eligibility": "eligible",
                            "createdAtMs": row["created_at_ms"] or (row["created_at"] or 0) * 1000, "updatedAtMs": row["updated_at_ms"]})
        fallback = {"schemaVersion": 1, "catalog": catalog, "groups": [], "relationsAvailable": False}
        if not include_relations:
            return fallback
        try:
            spec = importlib.util.spec_from_file_location("cncc_relations", Path(__file__).with_name("sync-relations.py"))
            relations = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(relations)
            with connect_readonly(codex_home / "thread_history_1.sqlite") as history:
                manifest = relations.build_manifest(history, state, roots)
            manifest["relationsAvailable"] = True
            return manifest
        except Exception:
            # A damaged or changed relationship source must not remove the flat
            # catalog. The caller must explicitly choose selected-only mode.
            fallback["relationMessage"] = "层级读取暂不可用，可取消包含下级，仅归档勾选聊天。"
            return fallback


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", type=Path, default=Path(os.environ.get("CNCC_CODEX_HOME", Path.home() / ".codex")))
    args = parser.parse_args()
    print(json.dumps(read_catalog(args.codex_home), ensure_ascii=False))
