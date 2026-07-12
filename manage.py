#!/usr/bin/env python3
"""Admin / DB management CLI for Tex Word Studio.

Generates the RSA signing keys, manages user accounts (create/list/passwd/role/
delete), and reports/maintains the SQLite metadata store. Run with the project
env, e.g.::

    uv run python manage.py init-keys
    uv run python manage.py create-admin --username alice
    uv run python manage.py list-users
    uv run python manage.py db-info

The DB path follows the app: ``TEX2WORD_DB`` env or ``config.toml``'s
``[backend].metasqlite_db``. Key paths come from ``[auth]``.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys

from app import auth
from app.config import get_config
from app.db import Database, default_db_path
from app.skills import SkillError, SkillStore
from app.users import UserError, UserStore


def _store() -> UserStore:
    return UserStore(Database())


def _prompt_password(provided: str | None) -> str:
    if provided:
        return provided
    pw = getpass.getpass("Password: ")
    if pw != getpass.getpass("Confirm password: "):
        sys.exit("error: passwords do not match")
    if not pw:
        sys.exit("error: password must not be empty")
    return pw


# -- commands ----------------------------------------------------------------
def cmd_init_keys(args: argparse.Namespace) -> None:
    cfg = get_config().auth
    priv_path, pub_path = cfg.private_key_path, cfg.public_key_path
    if os.path.exists(priv_path) and not args.force:
        sys.exit(f"error: {priv_path} already exists (use --force to overwrite)")
    private_pem, public_pem = auth.generate_keypair(bits=args.bits)
    with open(priv_path, "wb") as fh:
        fh.write(private_pem)
    os.chmod(priv_path, 0o600)
    with open(pub_path, "wb") as fh:
        fh.write(public_pem)
    print(f"wrote {priv_path} (0600) and {pub_path}")
    print("set `[auth] enabled = true` in config.toml to require login.")


def cmd_create_admin(args: argparse.Namespace) -> None:
    _create(args, role="admin")


def cmd_create_user(args: argparse.Namespace) -> None:
    _create(args, role="user")


def _create(args: argparse.Namespace, role: str) -> None:
    store = _store()
    pw = _prompt_password(args.password)
    try:
        user = store.create(args.username, pw, role=role)
    except UserError as exc:
        sys.exit(f"error: {exc}")
    print(f"created {role} {user.username!r} (id {user.id})")


def cmd_list_users(args: argparse.Namespace) -> None:
    users = _store().list()
    if not users:
        print("(no users)")
        return
    print(f"{'USERNAME':<24} {'ROLE':<8} CREATED")
    for u in users:
        print(f"{u.username:<24} {u.role:<8} {u.created_at}")


def cmd_passwd(args: argparse.Namespace) -> None:
    pw = _prompt_password(args.password)
    if not _store().set_password(args.username, pw):
        sys.exit(f"error: no such user {args.username!r}")
    print(f"updated password for {args.username!r}")


def cmd_set_role(args: argparse.Namespace) -> None:
    try:
        ok = _store().set_role(args.username, args.role)
    except UserError as exc:
        sys.exit(f"error: {exc}")
    if not ok:
        sys.exit(f"error: no such user {args.username!r}")
    print(f"{args.username!r} is now {args.role}")


def cmd_delete_user(args: argparse.Namespace) -> None:
    if not _store().delete(args.username):
        sys.exit(f"error: no such user {args.username!r}")
    print(f"deleted {args.username!r}")


def cmd_db_info(args: argparse.Namespace) -> None:
    path = default_db_path()
    db = Database(path)
    with db.lock:
        c = db.conn

        def n(sql: str) -> int:
            return c.execute(sql).fetchone()[0]

        projects = n("SELECT COUNT(*) FROM projects")
        files = n("SELECT COUNT(*) FROM files")
        binaries = n("SELECT COUNT(*) FROM files WHERE is_binary = 1")
        users = n("SELECT COUNT(*) FROM users")
        page_count = n("PRAGMA page_count")
        page_size = n("PRAGMA page_size")
    size = page_count * page_size
    exists = os.path.exists(path)
    print(f"database : {path}{'' if exists else ' (not yet created)'}")
    print(f"size     : {size/1024:.1f} KiB")
    print(f"projects : {projects}")
    print(f"files    : {files} ({binaries} binary)")
    print(f"users    : {users}")


def cmd_add_skill(args: argparse.Namespace) -> None:
    store = SkillStore(Database())
    try:
        skill = store.create(
            args.name, args.title or args.name, args.prompt,
            description=args.description or "", is_code=args.is_code,
        )
    except SkillError as exc:
        sys.exit(f"error: {exc}")
    print(f"created skill /{skill.name} ({'code' if skill.is_code else 'prose'})")


def cmd_list_skills(args: argparse.Namespace) -> None:
    from app import skills as skills_mod

    store = SkillStore(Database())
    print(f"{'SKILL':<16} {'SCOPE':<8} {'CODE':<5} TITLE")
    for s in skills_mod.all_skills(store):
        print(f"/{s.name:<15} {s.scope:<8} {'yes' if s.is_code else 'no':<5} {s.title}")


def cmd_delete_skill(args: argparse.Namespace) -> None:
    if not SkillStore(Database()).delete(args.name):
        sys.exit(f"error: no such custom skill {args.name!r}")
    print(f"deleted skill /{args.name}")


def cmd_db_vacuum(args: argparse.Namespace) -> None:
    db = Database(default_db_path())
    with db.lock:
        db.conn.execute("VACUUM")
        db.conn.commit()
    print("VACUUM complete")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="manage.py", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)

    k = sub.add_parser("init-keys", help="generate the RSA signing keypair")
    k.add_argument("--bits", type=int, default=2048)
    k.add_argument("--force", action="store_true", help="overwrite existing keys")
    k.set_defaults(func=cmd_init_keys)

    for name, fn, helptext in (
        ("create-admin", cmd_create_admin, "create an admin account"),
        ("create-user", cmd_create_user, "create a regular account"),
    ):
        c = sub.add_parser(name, help=helptext)
        c.add_argument("--username", required=True)
        c.add_argument("--password", help="(prompted securely if omitted)")
        c.set_defaults(func=fn)

    lu = sub.add_parser("list-users", help="list accounts")
    lu.set_defaults(func=cmd_list_users)

    pw = sub.add_parser("passwd", help="reset a user's password")
    pw.add_argument("--username", required=True)
    pw.add_argument("--password", help="(prompted securely if omitted)")
    pw.set_defaults(func=cmd_passwd)

    sr = sub.add_parser("set-role", help="change a user's role")
    sr.add_argument("--username", required=True)
    sr.add_argument("--role", required=True, choices=["admin", "user"])
    sr.set_defaults(func=cmd_set_role)

    du = sub.add_parser("delete-user", help="delete an account")
    du.add_argument("--username", required=True)
    du.set_defaults(func=cmd_delete_user)

    ak = sub.add_parser("add-skill", help="add a custom assistant skill")
    ak.add_argument("--name", required=True, help="slash name, e.g. summarize")
    ak.add_argument("--title", help="display title")
    ak.add_argument("--prompt", required=True,
                    help="template; {source} {input} {context} are filled in")
    ak.add_argument("--description", help="autocomplete hint")
    ak.add_argument("--is-code", action="store_true",
                    help="reply replaces the file (offered as a diff)")
    ak.set_defaults(func=cmd_add_skill)

    ls = sub.add_parser("list-skills", help="list built-in + custom skills")
    ls.set_defaults(func=cmd_list_skills)

    ds = sub.add_parser("delete-skill", help="delete a custom skill")
    ds.add_argument("--name", required=True)
    ds.set_defaults(func=cmd_delete_skill)

    di = sub.add_parser("db-info", help="show database statistics")
    di.set_defaults(func=cmd_db_info)

    dv = sub.add_parser("db-vacuum", help="compact the database")
    dv.set_defaults(func=cmd_db_vacuum)

    return p


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
