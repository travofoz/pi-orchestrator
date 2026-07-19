# 02_littlefs_storage_engine

## Objective
Replace SPIFFS with LittleFS for dashboard asset storage and implement mount/format/unmount lifecycle

## Done When
LittleFS partition mounts on boot. Directory tree traversal works for arbitrary depth. Power-loss corruption resistance verified via forced-unplug test. SPIFFS dependency entirely removed from build.
