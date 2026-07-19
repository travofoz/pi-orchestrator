# 08_crypto_handshake_spake2_mtls

## Objective
Implement SPAKE2 PAKE handshake over TCP, transition to mTLS 1.3, and persist RSA-2048 identity in NVS

## Done When
Raw TCP socket sends STLS\n token. 6-digit PIN seeds mbedtls ECP group for SPAKE2. Session upgrades to TLS 1.3 mbedtls_ssl context. RSA-2048 keypair auto-generated on first run. X.509 cert served to Android daemon. Thumbprint whitelisted.
