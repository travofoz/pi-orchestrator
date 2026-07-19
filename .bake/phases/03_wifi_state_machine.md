# 03_wifi_state_machine

## Objective
Build non-blocking 5-phase Wi-Fi lifecycle state machine using millis() timers

## Done When
Phase 1 NVS wifi_mode evaluation, Phase 2 async STA connection monitor with configurable timeout, Phase 3 SoftAP fallback (192.168.4.1/24, DHCP pool 2-10), Phase 4 inactivity watchdog, and Phase 5 deep sleep all transition correctly. No delay() calls anywhere.
