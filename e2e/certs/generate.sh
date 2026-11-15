#!/bin/sh
# Generates a throwaway test CA, 1 TLS certificate per e2e host, and the RSA signing keys.
# Runs inside the `certs` setup container; output goes to /out (a shared volume).
set -eu

out=/out
if [ -f "$out/.done" ]; then
  exit 0
fi

apk add --no-cache openssl >/dev/null

openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=e2e test CA" \
  -keyout "$out/ca.key" -out "$out/ca.crt" 2>/dev/null

for host in auth.e2e.test id.e2e.test photos.e2e.test; do
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$host" \
    -keyout "$out/$host.key" -out "$out/$host.csr" 2>/dev/null
  printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "$host" > "$out/$host.ext"
  openssl x509 -req -in "$out/$host.csr" -CA "$out/ca.crt" -CAkey "$out/ca.key" \
    -CAcreateserial -days 2 -extfile "$out/$host.ext" -out "$out/$host.crt" 2>/dev/null
  cat "$out/$host.crt" "$out/ca.crt" > "$out/$host.chain.crt"
  rm "$out/$host.csr" "$out/$host.ext"
done

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$out/bridge-signing-key.pem" 2>/dev/null
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$out/authelia-oidc-key.pem" 2>/dev/null

# Readable by the non-root users of every container in the stack; test material only.
chmod 644 "$out"/*
touch "$out/.done"
