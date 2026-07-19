# 11_nvs_configuration_persistence

## Objective
Implement Preferences-backed NVS storage for all runtime configuration keys

## Done When
Keys persisted: wifi_mode, sta_ssid, sta_pass, sta_timeout, ap_ssid, ap_pass, ap_watchdog. Factory clear (10s hold) reformats NVS namespace. Defaults applied on first boot if keys missing.
