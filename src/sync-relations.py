"""Rebuild a scoped relationship manifest from successful desktop creation events.

The Codex databases are opened read-only. This writes only this experiment's
relations.json, never a desktop database or configuration. Subagent spawns and
later send_message_to_thread events are deliberately excluded.
"""
from __future__ import annotations

import argparse
from collections import deque
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import uuid

USER_THREAD_SOURCES = frozenset(("user", "agent_created_thread", "agent_forked_thread", "voice_chat", "realtime_voice"))


def connect_readonly(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=3)
    connection.execute("PRAGMA query_only=ON")
    connection.row_factory = sqlite3.Row
    return connection


def decode_result(result):
    """Decode only the creation call's structured result or text JSON blocks."""
    if not isinstance(result, dict) or result.get("isError"):
        return []
    candidates = []
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        candidates.append(structured)
    if isinstance(result.get("threadId"), str):
        candidates.append(result)
    for block in result.get("content", []):
        if not isinstance(block, dict) or block.get("type") != "text":
            continue
        try:
            value = json.loads(block.get("text", ""))
        except (ValueError, TypeError):
            continue
        if isinstance(value, dict):
            if isinstance(value.get("threadId"), str):
                candidates.append(value)
            elif "content" in value:
                candidates.extend(decode_result(value))
    return candidates


def valid_uuid(value):
    if not isinstance(value, str):
        return False
    try:
        return str(uuid.UUID(value)) == value.lower()
    except ValueError:
        return False


def classify_thread(row):
    if row is None:
        return "missing"
    if row["archived"]:
        return "archived"
    raw_source = row["source"] or ""
    # Noninteractive codex exec runs are not desktop sidebar chats. Their
    # thread_source can still be "user", including when Desktop launched them.
    if raw_source == "exec":
        return "execution_record"
    if row["agent_path"] or row["thread_source"] in ("subagent", "automation"):
        return "system_or_subagent"
    try:
        parsed_source = json.loads(raw_source)
    except (ValueError, TypeError):
        parsed_source = None
    if isinstance(parsed_source, dict) and "subagent" in parsed_source:
        return "system_or_subagent"
    if row["thread_source"] not in USER_THREAD_SOURCES:
        return "unknown_source"
    return "eligible"


def candidate_roots(state):
    rows = state.execute(
        "SELECT id,name,archived,thread_source,source,agent_path FROM threads "
        "ORDER BY updated_at_ms DESC,id").fetchall()
    counts = {}
    roots = []
    for row in rows:
        category = classify_thread(row)
        counts[category] = counts.get(category, 0) + 1
        if category == "eligible" and valid_uuid(row["id"]):
            roots.append(row["id"])
    return roots, counts


def collect_fork_edges(history, state):
    """A fork is parented by its source chat, which may differ from its caller."""
    owners, _ = candidate_roots(state)
    edges = {}
    for owner_id in owners:
        calls = history.execute(
            "SELECT item_id,item_json FROM thread_items WHERE thread_id=? "
            "AND item_type='mcpToolCall' "
            "AND json_extract(item_json,'$.server')='codex_app' "
            "AND json_extract(item_json,'$.tool')='fork_thread' "
            "ORDER BY rollout_ordinal", (owner_id,))
        for call in calls:
            try:
                event = json.loads(call["item_json"])
            except ValueError:
                continue
            if (event.get("type") != "mcpToolCall" or event.get("server") != "codex_app"
                    or event.get("tool") != "fork_thread" or event.get("status") != "completed"
                    or event.get("error") is not None):
                continue
            arguments = event.get("arguments") or {}
            for result in decode_result(event.get("result")):
                # A queued worktree has clientThreadId, not a completed threadId.
                # Neither a queued ID nor a merely completed tool invocation is
                # sufficient evidence that the child chat was actually created.
                if result.get("status") != "created" or result.get("clientThreadId"):
                    continue
                parent_id = result.get("sourceThreadId")
                child_id = result.get("threadId")
                requested_source = arguments.get("threadId") or owner_id
                if (not valid_uuid(parent_id) or not valid_uuid(child_id)
                        or parent_id != requested_source or parent_id == child_id):
                    continue
                source = "fork_thread:" + owner_id + ":" + call["item_id"]
                edges.setdefault(parent_id, {})[child_id] = source
    return edges


def build_manifest(history, state, roots, limit=None):
    queue = deque(roots)
    visited = set()
    groups = []
    fork_edges = collect_fork_edges(history, state)

    def row_for(ident):
        return state.execute(
            "SELECT id,name,archived,thread_source,source,agent_path,created_at_ms,created_at,updated_at_ms FROM threads WHERE id=?",
            (ident,)).fetchone()

    def node(ident, fallback=""):
        row = row_for(ident)
        # In this schema `name` is the desktop title; `title` can hold a raw
        # user message and must not be displayed as if it were the chat name.
        return {"id": ident, "title": (row["name"] if row else None) or fallback or ident,
                "kind": "codex", "hostId": "local",
                "threadSource": row["thread_source"] if row else None,
                "eligibility": classify_thread(row),
                "createdAtMs": (row["created_at_ms"] or row["created_at"] * 1000) if row else None,
                "updatedAtMs": row["updated_at_ms"] if row else None}

    while queue:
        parent_id = queue.popleft()
        if parent_id in visited:
            continue
        parent_row = row_for(parent_id)
        if classify_thread(parent_row) != "eligible":
            continue
        if limit is not None and len(visited) >= limit:
            raise RuntimeError("Reachable-chat limit exceeded; original manifest was preserved.")
        visited.add(parent_id)
        children = {}
        sources = []
        calls = history.execute(
            "SELECT item_id,item_json,created_at_ms FROM thread_items WHERE thread_id=? "
            "AND item_type='mcpToolCall' "
            "AND json_extract(item_json,'$.server')='codex_app' "
            "AND json_extract(item_json,'$.tool')='create_thread' "
            "ORDER BY rollout_ordinal", (parent_id,))
        for call in calls:
            # Forks retain earlier history. A creation event predating this
            # fork's own creation belongs to its source, not to the fork.
            if parent_row["thread_source"] == "agent_forked_thread":
                parent_created = parent_row["created_at_ms"] or parent_row["created_at"] * 1000
                if call["created_at_ms"] < parent_created:
                    continue
            try:
                event = json.loads(call["item_json"])
            except ValueError:
                continue
            if (event.get("type") != "mcpToolCall" or event.get("server") != "codex_app"
                    or event.get("tool") != "create_thread" or event.get("status") != "completed"
                    or event.get("error") is not None):
                continue
            arguments = event.get("arguments") or {}
            target = arguments.get("target") or {}
            # Cloud chats need a different identity/router adapter; do not pretend
            # that a UUID in a cloud result identifies a local Codex chat.
            if target.get("type") not in ("projectless", "project"):
                continue
            for result in decode_result(event.get("result")):
                child_id = result.get("threadId")
                host = result.get("hostId")
                if not valid_uuid(child_id) or host != "local" or child_id == parent_id:
                    continue
                if classify_thread(row_for(child_id)) != "eligible":
                    continue
                children[child_id] = node(child_id, arguments.get("title", ""))
                sources.append("create_thread:" + call["item_id"])
        for child_id, source in fork_edges.get(parent_id, {}).items():
            if classify_thread(row_for(child_id)) != "eligible":
                continue
            children[child_id] = node(child_id)
            sources.append(source)
        attached = state.execute(
            "SELECT id,name FROM threads WHERE attached_thread_parent_id=? ORDER BY created_at_ms,id",
            (parent_id,))
        for row in attached:
            child_id = row["id"]
            if not valid_uuid(child_id) or child_id == parent_id:
                continue
            if classify_thread(row_for(child_id)) != "eligible":
                continue
            children[child_id] = node(child_id, row["name"] or "")
            sources.append("attached_thread_parent_id:" + child_id)
        if children:
            groups.append({"parent": node(parent_id), "children": list(children.values()),
                           "source": "; ".join(sources)})
            queue.extend(children)
    # A standalone chat belongs in the selection catalog, never in a fabricated
    # relationship group. All entries passed the same read-only eligibility gate.
    catalog_order = dict.fromkeys([*roots, *sorted(visited)])
    return {"schemaVersion": 1, "groups": groups,
            "catalog": [node(ident) for ident in catalog_order if ident in visited]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", type=Path, default=Path(os.environ.get("CNCC_CODEX_HOME", Path.home() / ".codex")))
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("relations.json"))
    parser.add_argument("--root", action="append", default=[])
    parser.add_argument("--check", action="store_true", help="Print counts without writing anything.")
    parser.add_argument("--manifest-stdout", action="store_true",
                        help="Return a fresh read-only manifest on stdout without writing a file.")
    args = parser.parse_args()
    if not all(valid_uuid(ident) for ident in args.root):
        parser.error("Each root must be a chat UUID.")
    with connect_readonly(args.codex_home / "thread_history_1.sqlite") as history, \
            connect_readonly(args.codex_home / "state_5.sqlite") as state:
        candidates, eligibility_counts = candidate_roots(state)
        roots = args.root or candidates
        if args.root and not set(args.root).issubset(candidates):
            parser.error("Explicit roots must be existing, unarchived user chats, excluding system/subagent/unknown sources.")
        manifest = build_manifest(history, state, roots)
    if args.manifest_stdout:
        print(json.dumps(manifest, ensure_ascii=False))
        return
    changed = True
    if args.output.exists():
        with args.output.open(encoding="utf-8-sig") as source:
            changed = json.load(source) != manifest
    if changed and not args.check:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        # Write beside the destination then replace atomically so readers never
        # see half a JSON document. This replaces only our generated manifest.
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=args.output.parent,
                                         prefix=".relations-", suffix=".json", delete=False) as target:
            json.dump(manifest, target, ensure_ascii=False, indent=2)
            target.write("\n")
            temporary = Path(target.name)
        temporary.replace(args.output)
    print(json.dumps({"groups": len(manifest["groups"]),
                      "children": sum(len(group["children"]) for group in manifest["groups"]),
                      "scope": "explicit_roots" if args.root else "all_existing_user_chats",
                      "eligibleCandidateChats": len(candidates),
                      "eligibilityCounts": eligibility_counts,
                      "parentNames": [group["parent"]["title"] for group in manifest["groups"]],
                      "changed": changed, "written": changed and not args.check,
                      "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
