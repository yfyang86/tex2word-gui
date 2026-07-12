import pytest
from fastapi.testclient import TestClient

from app import auth
from app.auth import AuthError, Authenticator
from app.db import Database
from app.main import app
from app.users import UserError, UserStore


# -- passwords (scrypt) ------------------------------------------------------
def test_password_hash_roundtrip():
    h = auth.hash_password("correct horse battery")
    assert h.startswith("scrypt$")
    assert auth.verify_password("correct horse battery", h)
    assert not auth.verify_password("wrong", h)


def test_password_hashes_are_salted():
    assert auth.hash_password("same") != auth.hash_password("same")


def test_verify_rejects_garbage():
    assert auth.verify_password("x", "not-a-valid-hash") is False


# -- RSA-signed JWTs ---------------------------------------------------------
def _signer(issuer="tex2word-web", ttl=1):
    priv, pub = auth.generate_keypair()
    return Authenticator(enabled=True, private_key=priv, public_key=pub,
                         ttl_hours=ttl, issuer=issuer), priv, pub


def test_token_issue_and_verify():
    a, _, _ = _signer()
    claims = a.verify_token(a.issue_token(subject="alice", role="admin"))
    assert claims["sub"] == "alice" and claims["role"] == "admin"


def test_token_bad_signature_rejected():
    a, _, _ = _signer()
    _, _, other_pub = _signer()
    a.public_key = other_pub  # verify with the wrong key
    with pytest.raises(AuthError):
        a.verify_token(a.issue_token(subject="x", role="user"))


def test_token_wrong_issuer_rejected():
    priv, pub = auth.generate_keypair()
    signer = Authenticator(enabled=True, private_key=priv, public_key=pub, issuer="a")
    verifier = Authenticator(enabled=True, private_key=priv, public_key=pub, issuer="b")
    with pytest.raises(AuthError):
        verifier.verify_token(signer.issue_token(subject="x", role="user"))


def test_token_expired_rejected():
    a, _, _ = _signer(ttl=-1)  # exp is already in the past
    with pytest.raises(AuthError):
        a.verify_token(a.issue_token(subject="x", role="user"))


def test_issue_without_key_raises():
    a = Authenticator(enabled=True)
    with pytest.raises(AuthError):
        a.issue_token(subject="x", role="user")


# -- user store --------------------------------------------------------------
@pytest.fixture
def store(tmp_path):
    return UserStore(Database(str(tmp_path / "u.db")))


def test_user_create_and_authenticate(store):
    u = store.create("alice", "pw12345", role="admin")
    assert u.role == "admin" and "password" not in u.public()
    assert store.authenticate("alice", "pw12345").username == "alice"
    assert store.authenticate("alice", "bad") is None
    assert store.authenticate("ghost", "x") is None
    assert store.count() == 1


def test_user_duplicate_username(store):
    store.create("a", "secret12")
    with pytest.raises(UserError):
        store.create("a", "other123")


def test_user_bad_role(store):
    with pytest.raises(UserError):
        store.create("a", "secret12", role="superuser")


def test_user_passwd_role_delete(store):
    store.create("bob", "old_pass1")
    assert store.set_password("bob", "new_pass2") is True
    assert store.authenticate("bob", "new_pass2").username == "bob"
    assert store.set_role("bob", "admin") is True
    assert store.get_by_username("bob").role == "admin"
    assert store.delete("bob") is True
    assert store.get_by_username("bob") is None
    assert store.set_password("bob", "x") is False  # gone


# -- endpoints (auth toggled on at runtime) ----------------------------------
@pytest.fixture
def auth_on():
    from app import main as m

    priv, pub = auth.generate_keypair()
    prev = (m.authn.enabled, m.authn.private_key, m.authn.public_key)
    m.authn.enabled = True
    m.authn.private_key = priv
    m.authn.public_key = pub
    m.users.delete("admin")  # clear any leftover from a prior run
    m.users.create("admin", "adminpw1", role="admin")
    yield m
    m.authn.enabled, m.authn.private_key, m.authn.public_key = prev
    m.users.delete("admin")


def test_protected_requires_token(auth_on):
    c = TestClient(app)
    assert c.get("/api/projects").status_code == 401
    # open routes remain reachable without a session
    assert c.get("/api/health").status_code == 200
    assert c.get("/api/config").json()["auth"]["enabled"] is True


def test_login_then_access(auth_on):
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"username": "admin", "password": "adminpw1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["user"]["role"] == "admin"
    h = {"Authorization": f"Bearer {body['token']}"}
    assert c.get("/api/projects", headers=h).status_code == 200
    me = c.get("/api/auth/me", headers=h).json()
    assert me["username"] == "admin" and me["role"] == "admin"


def test_login_bad_credentials(auth_on):
    c = TestClient(app)
    assert c.post("/api/auth/login",
                  json={"username": "admin", "password": "nope"}).status_code == 401


def test_bad_token_rejected(auth_on):
    c = TestClient(app)
    assert c.get("/api/projects",
                 headers={"Authorization": "Bearer not.a.jwt"}).status_code == 401


def test_query_param_token_accepted(auth_on):
    # <img>/<a download> can't set headers → token via ?access_token works
    c = TestClient(app)
    tok = c.post("/api/auth/login",
                 json={"username": "admin", "password": "adminpw1"}).json()["token"]
    assert c.get(f"/api/projects?access_token={tok}").status_code == 200
    assert c.get("/api/projects?access_token=bogus").status_code == 401


def test_login_disabled_is_400():
    # auth is off by default → the login endpoint refuses
    assert TestClient(app).post(
        "/api/auth/login", json={"username": "x", "password": "y"}
    ).status_code == 400


# -- admin CLI ---------------------------------------------------------------
def test_manage_create_list_and_info(tmp_path, monkeypatch, capsys):
    import manage

    monkeypatch.setenv("TEX2WORD_DB", str(tmp_path / "m.db"))
    manage.main(["create-admin", "--username", "root", "--password", "rootpw123"])
    manage.main(["list-users"])
    out = capsys.readouterr().out
    assert "root" in out and "admin" in out
    manage.main(["db-info"])
    assert "users    : 1" in capsys.readouterr().out


def test_manage_init_keys(tmp_path, monkeypatch):
    import manage
    from app.config import AuthConfig, get_config

    cfg = get_config()
    monkeypatch.setattr(cfg, "auth", AuthConfig(
        private_key_path=str(tmp_path / "priv.pem"),
        public_key_path=str(tmp_path / "pub.pem"),
    ))
    manage.main(["init-keys"])
    assert (tmp_path / "priv.pem").exists() and (tmp_path / "pub.pem").exists()
