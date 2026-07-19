# 06_20s_release_to_rollback_protocol

## Objective
Implement the strapping-pin-safe partition rollback handshake triggered by 20-second button hold

## Done When
Holding GPIO9 for 20s sets rollback_armed flag. LED strobes at 3-flash / 500ms pattern. Release triggers 2s vTaskDelay and GPIO9-HIGH validation. esp_ota_set_boot_partition() flips to inactive slot, then esp_restart(). Strapping pin lockup never engages.
