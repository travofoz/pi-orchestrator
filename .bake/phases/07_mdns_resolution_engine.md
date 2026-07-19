# 07_mdns_resolution_engine

## Objective
Implement mDNS responder and query engine for Android Wireless Debugging service discovery

## Done When
mdns_query_ptr() resolves _adb-tls-pairing._tcp and _adb-tls-connect._tcp services. Ephemeral port numbers extracted and surfaced to frontend. Non-blocking with configurable sweep interval.
