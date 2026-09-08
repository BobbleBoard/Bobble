#!/usr/bin/env bash
# A STABLE local code-signing identity, so computer-use permissions survive a
# rebuild.
#
# Ad-hoc signing (`codesign --sign -`) pins the designated requirement to the
# binary's cdhash:
#
#   designated => cdhash H"a238a7b5…"
#
# macOS keys the Accessibility and Screen Recording grants to that requirement,
# so EVERY ship produced a new hash and silently revoked both. The symptom is
# brutal to diagnose from the outside: computer use works right after you grant
# it, then quietly returns zero elements and no pixels after the next build,
# with no error and nothing removed from System Settings.
#
# Signing with a self-signed certificate instead gives a requirement that does
# not move:
#
#   designated => identifier "app.pidesktop.desktop" and certificate leaf = H"…"
#
# The certificate is not trusted by the system (nor does it need to be — this is
# not Gatekeeper distribution, and a locally built app carries no quarantine
# flag). It lives in its own keychain so the login keychain is never touched.
# Grant the two permissions once and every later build inherits them.
set -euo pipefail

KEYCHAIN="$HOME/Library/Keychains/bobble-signing.keychain-db"
KEYCHAIN_PASS="bobble"
IDENTITY="Bobble Local Signing"

if ! security find-certificate -c "$IDENTITY" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "signing-identity: creating the local signing certificate (one time)" >&2
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  cat > "$work/ext.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = Bobble Local Signing
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
  openssl req -x509 -newkey rsa:2048 -keyout "$work/key.pem" -out "$work/cert.pem" \
    -days 3650 -nodes -config "$work/ext.cnf" 2>/dev/null
  openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" \
    -out "$work/id.p12" -passout "pass:$KEYCHAIN_PASS" -name "$IDENTITY" 2>/dev/null
  security create-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN" 2>/dev/null || true
  security set-keychain-settings -lut 100000 "$KEYCHAIN"
  security unlock-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN"
  security import "$work/id.p12" -k "$KEYCHAIN" -P "$KEYCHAIN_PASS" -T /usr/bin/codesign -A
  # Without a partition list every codesign call pops a keychain-access dialog —
  # which would take the user's screen in the middle of an automated ship.
  security set-key-partition-list -S apple-tool:,apple:,codesign: \
    -s -k "$KEYCHAIN_PASS" "$KEYCHAIN" >/dev/null 2>&1 || true
fi

security unlock-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN"
# codesign only searches the keychain SEARCH LIST, so the signing keychain has
# to be on it (idempotent: re-adding an entry that is already there is a no-op).
current="$(security list-keychains -d user | sed -e 's/^[[:space:]]*"//' -e 's/"$//')"
if ! grep -qF "$KEYCHAIN" <<<"$current"; then
  # shellcheck disable=SC2086
  security list-keychains -d user -s $current "$KEYCHAIN"
fi

echo "$IDENTITY"
