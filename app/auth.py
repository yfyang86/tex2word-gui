"""Authentication primitives: scrypt password hashing and RSA-signed JWTs.

Passwords are hashed with the stdlib :func:`hashlib.scrypt` (memory-hard, with a
per-user salt) — they are *hashed*, never reversibly encrypted. Sessions are
JSON Web Tokens signed with an RSA private key (RS256) and verified with the
public key, so a token can be validated without the signing secret.

Auth is **opt-in**: when ``[auth].enabled`` is false the rest of the app runs
exactly as before and these helpers are unused.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

# scrypt cost parameters (RFC 7914). N must be a power of two.
_SCRYPT_N = 2 ** 14
_SCRYPT_R = 8
_SCRYPT_P = 1
_SCRYPT_DKLEN = 32
_SALT_BYTES = 16

_ALGORITHM = "RS256"


class AuthError(Exception):
    """Raised for a bad credential, an invalid/expired token, or missing keys."""


# --------------------------------------------------------------------------- #
# Passwords — scrypt with a per-hash salt
# --------------------------------------------------------------------------- #
def hash_password(password: str) -> str:
    """Return a self-describing ``scrypt$N$r$p$salt$hash`` string (base64 parts)."""
    if not password:
        raise AuthError("password must not be empty")
    salt = os.urandom(_SALT_BYTES)
    dk = hashlib.scrypt(
        password.encode("utf-8"), salt=salt,
        n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=_SCRYPT_DKLEN,
    )
    b64 = lambda b: base64.b64encode(b).decode("ascii")
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${b64(salt)}${b64(dk)}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time check of ``password`` against a :func:`hash_password` string."""
    try:
        scheme, n, r, p, salt_b64, hash_b64 = stored.split("$")
        if scheme != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        dk = hashlib.scrypt(
            password.encode("utf-8"), salt=salt,
            n=int(n), r=int(r), p=int(p), dklen=len(expected),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk, expected)


# --------------------------------------------------------------------------- #
# RSA keys
# --------------------------------------------------------------------------- #
def generate_keypair(bits: int = 2048) -> tuple[bytes, bytes]:
    """Generate an RSA keypair; return ``(private_pem, public_pem)`` (PEM bytes)."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=bits)
    private_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_pem = key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return private_pem, public_pem


# --------------------------------------------------------------------------- #
# Authenticator — issue / verify JWTs, gated by config
# --------------------------------------------------------------------------- #
@dataclass
class Authenticator:
    enabled: bool = False
    private_key: bytes | None = None
    public_key: bytes | None = None
    ttl_hours: int = 12
    issuer: str = "tex2word-web"

    @classmethod
    def from_config(cls, auth_cfg: Any) -> "Authenticator":
        """Build from an ``AuthConfig``; loads PEM keys when auth is enabled."""
        priv = pub = None
        if auth_cfg.enabled:
            priv = _read_pem(auth_cfg.private_key_path)
            pub = _read_pem(auth_cfg.public_key_path)
        return cls(
            enabled=auth_cfg.enabled,
            private_key=priv,
            public_key=pub,
            ttl_hours=auth_cfg.token_ttl_hours,
            issuer=auth_cfg.issuer,
        )

    def issue_token(self, *, subject: str, role: str) -> str:
        if not self.private_key:
            raise AuthError("no signing key configured (run the admin script's init-keys)")
        now = datetime.now(timezone.utc)
        claims = {
            "sub": subject,
            "role": role,
            "iss": self.issuer,
            "iat": now,
            "exp": now + timedelta(hours=self.ttl_hours),
        }
        return jwt.encode(claims, self.private_key, algorithm=_ALGORITHM)

    def verify_token(self, token: str) -> dict[str, Any]:
        if not self.public_key:
            raise AuthError("no verification key configured")
        try:
            return jwt.decode(
                token, self.public_key, algorithms=[_ALGORITHM], issuer=self.issuer
            )
        except jwt.PyJWTError as exc:
            raise AuthError(f"invalid token: {exc}") from exc


def _read_pem(path: str) -> bytes:
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except OSError as exc:
        raise AuthError(
            f"cannot read key {path!r} — generate it with the admin script "
            f"(`python manage.py init-keys`)"
        ) from exc
