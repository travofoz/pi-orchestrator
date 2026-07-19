# 05_deep_sleep_coffin_mode

## Objective
Implement Phase 5 deep sleep with RTC GPIO9 wake interrupt and microamp current draw

## Done When
esp_deep_sleep_start() drops current to <10 µA. RTC interrupt on GPIO9 LOW edge wakes CPU into Phase 1. Radio fully disabled during sleep. External battery drain eliminated in backpack/pocket scenario.
