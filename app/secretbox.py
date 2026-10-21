"""Encryption at rest for secrets the app stores (provider API keys).

AES-256-GCM with a 96-bit random nonce per value. The master key comes from
the ``TEX2WORD_SECRET_KEY`` environment variable (32 bytes, url-safe base64)
or, failing that, a key file (``[security] secret_key_path``) created on first
use with mode 0600. Each ciphertext is bound to a context string (the
provider's name) as associated data, so a value copied to another row does not
decrypt.

Stored form: ``v1:<base64 nonce + ciphertext>``.
"""

from __future__ import annotations

import base64
import os
import secrets
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ENV_VAR = "TEX2WORD_SECRET_KEY"
_PREFIX = "v1:"


class SecretError(Exception):
    """A secret could not be encrypted or decrypted (bad key, tampered data)."""


def _decode_key(text: str) -> bytes:
    try:
        raw = base64.urlsafe_b64decode(text.strip() + "=" * (-len(text.strip()) % 4))
    except (ValueError, TypeError) as exc:
        raise SecretError(f"{ENV_VAR} / key file is not valid base64") from exc
    if len(raw) != 32:
        raise SecretError("the secret key must be 32 bytes (44 base64 characters)")
    return raw


def generate_key() -> str:
    """A new master key, url-safe base64."""
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()


def load_key(path: str | os.PathLike[str]) -> bytes:
    """The master key: the env var if set, else the key file (created if missing)."""
    env = os.environ.get(ENV_VAR)
    if env:
        return _decode_key(env)
    p = Path(path)
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass  # another worker created it first
        else:
            with os.fdopen(fd, "w") as fh:
                fh.write(generate_key() + "\n")
    return _decode_key(p.read_text())


class SecretBox:
    def __init__(self, key: bytes) -> None:
        if len(key) != 32:
            raise SecretError("the secret key must be 32 bytes")
        self._aead = AESGCM(key)

    def encrypt(self, plaintext: str, context: str) -> str:
        nonce = secrets.token_bytes(12)
        ct = self._aead.encrypt(nonce, plaintext.encode("utf-8"), context.encode("utf-8"))
        return _PREFIX + base64.urlsafe_b64encode(nonce + ct).decode()

    def decrypt(self, token: str, context: str) -> str:
        if not token or not token.startswith(_PREFIX):
            raise SecretError("unrecognised secret format")
        try:
            blob = base64.urlsafe_b64decode(token[len(_PREFIX):])
            return self._aead.decrypt(blob[:12], blob[12:], context.encode("utf-8")).decode("utf-8")
        except (InvalidTag, ValueError) as exc:
            raise SecretError(
                "could not decrypt a stored secret (was the secret key changed?)"
            ) from exc


def hint(secret: str) -> str:
    """The last four characters, for recognising a key without revealing it."""
    secret = secret or ""
    return secret[-4:] if len(secret) >= 12 else ""
